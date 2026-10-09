// The `hippo recall` verb; main() loads it lazily from the command table.

import { envHippoSessionId } from '../env.js';
import { confidenceFacets, Layer } from '../memory.js';
import { TaskSnapshot, SessionEvent } from '../store/rows.js';
import { isInitialized } from '../store/open.js';
import { loadIndex } from '../store/index-and-stats.js';
import { loadActiveTaskSnapshot, listSessionEvents } from '../store/sessions.js';
import { loadLatestHandoff } from '../store/handoffs.js';
import type { SessionHandoff } from '../handoff.js';
import { passesScopeFilterForRecall } from '../recall-scope.js';
import { fitBudget } from '../search/finalize.js';
import { explainMatch } from '../search/explain.js';
import { DEFAULT_RECALL_BUDGET, type SearchResult } from '../core/search-types.js';
import { loadConfig } from '../config.js';
import { estimateTokens } from '../util/token-text.js';
import { dropHeldCopies } from '../same-text.js';
import { isGlobalStoreRoot } from '../project-identity.js';
import { detectScope } from '../scope.js';
import { getGlobalRoot } from '../shared.js';
import * as api from '../api.js';
import type { PlanningFallacyOutput } from '../predictions/planning-fallacy.js';
import { detectAnchoring, hashQueryText, biasHintEnabled, snapshotRing } from '../recall-history.js';
import { noteRecall, resetSessionRings, sessionRing, shownRecallRows } from '../api/recall-record.js';
import { detectAvailabilityBias } from '../availability.js';
import { resolveTenantId } from '../tenant.js';
import { MAX_HOPS, DEFAULT_MAX_NEIGHBORS } from '../graph-recall.js';
import { getReranker } from '../rerankers/index.js';
import type { RerankerFn } from '../rerankers/types.js';
import type { RankRecallResult, RankStage, RecallGraphHops, RecallGraphStream, RecallReranker } from '../recall-pipeline.js';
import { JEV_DEFAULT_TOP_K } from '../rerankers/jev.js';
import { isClefModel } from '../rerankers/clef.js';
import { handoffText, printedTokens, sessionTrailText, settleTokens, snapshotText } from '../context-render.js';
import { printError } from './output.js';
import {
  parseLimitFlag,
  parseBudgetFlag,
  requireInit,
  recallEntryText,
  recallHeading,
  type CliFlags,
  type CommandContext,
  parseAsOfFlag,
  engineFlags,
  printActiveTaskSnapshot,
  printSessionEvents,
  printHandoff,
  hostSessionId,
  captureConsole,
  hookStoreRoot,
  boolFlag,
  flagIsTrue,
} from './shared.js';

// Per-process rings: a single-shot `hippo recall` starts empty, so anchoring only accumulates in long-lived
// hosts (in-process loops, `hippo serve`, the MCP server).
/** Test-only: reset the CLI recall rings. Call from beforeEach. */
export function __resetSessionRecallHistoryCli(): void {
  resetSessionRings('cli');
}

// JSON.stringify keeps quotes or parens in the matched phrase from blurring the line.
function planningLine(p: PlanningFallacyOutput): string | null {
  if (p.hint) return `Planning fallacy hint (class: ${p.hint.classTag}): ${p.hint.baserateSummary} [detected: ${JSON.stringify(p.hint.detectedPhrase)}]`;
  if (p.watching) return `Planning fallacy: watching this query (reason: ${p.watching.reason}). ${p.watching.suggestion} [detected: ${JSON.stringify(p.watching.detectedPhrase)}]`;
  return null;
}

function cutoffLine(shown: number, s: api.RecallSuppressionSummary): string | null {
  const clauses: string[] = [];
  // The residual covers rank, budget and limit drops alike, and fires with no --limit at all.
  if (s.droppedByBudget > 0) clauses.push(`${s.droppedByBudget} not shown (rank, budget or limit)`);
  if (s.droppedPreRank > 0) clauses.push(`${s.droppedPreRank} filtered pre-rank`);
  if (s.summarySubstitutionsAdded > 0) clauses.push(`${s.summarySubstitutionsAdded} summary substitutions added`);
  if (s.freshTailAdded > 0) clauses.push(`${s.freshTailAdded} fresh-tail added`);
  if (s.suppressedByInterference > 0) clauses.push(`${s.suppressedByInterference} suppressed by interference`);
  return clauses.length > 0 ? `Cutoff: showing ${shown} of ${s.totalCandidates} candidates; ${clauses.join('; ')}.` : null;
}

/** A flag value, or the deferred error that rejects it. */
interface ParsedFlag<T> { value?: T; fail?: () => never }

/** A flag the ranking stages read, rejected where the old mid-pipeline check printed its error. */
interface LateFlagError { stage: RankStage; fail: () => never }

interface RecallLateFlags {
  graphHops?: RecallGraphHops;
  reranker?: RecallReranker;
  salienceThreshold?: number;
  outcome?: string;
  layer?: string;
  error?: LateFlagError;
}

function failWith(message: string): () => never {
  return () => {
    printError(message);
    process.exit(1);
  };
}

/** `--graph-stream` implies rrf fusion as well as the graph stream; the CLI fuses the local store only. */
function parseGraphStreamFlags(flags: CliFlags): RecallGraphStream {
  let hops: number | undefined;
  if (flags['graph-hops'] !== undefined) {
    if (typeof flags['graph-hops'] === 'boolean') failWith(`--graph-hops requires an integer value 1..${MAX_HOPS} (e.g. --graph-hops 2).`)();
    const h = Number(flags['graph-hops']);
    if (!Number.isInteger(h) || h < 1 || h > MAX_HOPS) {
      failWith(`Invalid --graph-hops: "${String(flags['graph-hops'])}". Must be an integer 1..${MAX_HOPS}.`)();
    }
    hops = h;
  }
  let seeds: number | undefined;
  if (flags['graph-seeds'] !== undefined) {
    if (typeof flags['graph-seeds'] === 'boolean') failWith('--graph-seeds requires a positive integer value (e.g. --graph-seeds 10).')();
    const s = Number(flags['graph-seeds']);
    if (!Number.isInteger(s) || s < 1) failWith(`Invalid --graph-seeds: "${String(flags['graph-seeds'])}". Must be a positive integer.`)();
    seeds = s;
  }
  return { hops, seeds };
}

function parseHopsFlags(flags: CliFlags): ParsedFlag<RecallGraphHops> {
  if (flags['hops'] === undefined) return {};
  // A value-less `--hops` parses as true, and Number(true) === 1 would silently run a 1-hop expansion.
  if (typeof flags['hops'] === 'boolean') return { fail: failWith(`--hops requires an integer value 0..${MAX_HOPS} (e.g. --hops 1).`) };
  const hops = Number(flags['hops']);
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_HOPS) {
    return { fail: failWith(`Invalid --hops: "${String(flags['hops'])}". Must be an integer 0..${MAX_HOPS}.`) };
  }
  const raw = flags['max-neighbors'];
  if (raw === undefined) return { value: { hops, maxNeighbors: DEFAULT_MAX_NEIGHBORS } };
  if (typeof raw === 'boolean') return { fail: failWith(`--max-neighbors requires an integer value 1..200.`) };
  const maxNeighbors = Number(raw);
  if (!Number.isInteger(maxNeighbors) || maxNeighbors < 1 || maxNeighbors > 200) {
    return { fail: failWith(`Invalid --max-neighbors: "${String(raw)}". Must be an integer 1..200.`) };
  }
  return { value: { hops, maxNeighbors } };
}

function parseRerankerFlag(flags: CliFlags): ParsedFlag<RecallReranker> {
  const name = flags['reranker'] !== undefined ? String(flags['reranker']).trim() : '';
  let fn: RerankerFn | null;
  try {
    fn = getReranker(name);
  } catch (err) {
    // An unknown name throws to the top-level handler, as it did when the lookup sat mid-pipeline.
    return { fail: () => { throw err; } };
  }
  if (!fn) return {};
  const raw = flags['reranker-top-k'];
  const topK = raw !== undefined ? Number(raw) : name === 'jev' || isClefModel(name) ? JEV_DEFAULT_TOP_K : 50;
  // slice(0, -1) would quietly drop the last candidate rather than fail.
  if (!Number.isInteger(topK) || topK < 1) {
    return { fail: failWith(`Invalid --reranker-top-k: "${String(raw)}". Must be a positive integer.`) };
  }
  return { value: { fn, topK } };
}

function parseSalienceFlag(flags: CliFlags): ParsedFlag<number> {
  const raw = flags['salience-threshold'];
  if (raw === undefined) return {};
  const threshold = Number(raw);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { fail: failWith(`Invalid --salience-threshold: "${String(raw)}". Must be a positive number.`) };
  }
  return { value: threshold };
}

function parseChoiceFlag(flags: CliFlags, name: 'outcome' | 'layer', valid: readonly string[]): ParsedFlag<string> {
  const value = flags[name] !== undefined ? String(flags[name]).trim() : '';
  if (!value) return {};
  if (!valid.includes(value)) return { fail: failWith(`Invalid --${name}: "${value}". Must be one of: ${valid.join(', ')}.`) };
  return { value };
}

/** Parses every flag a ranking stage reads; the first invalid one in pipeline order becomes `error`. */
function parseRecallLateFlags(flags: CliFlags): RecallLateFlags {
  const graphHops = parseHopsFlags(flags);
  const reranker = parseRerankerFlag(flags);
  const salience = parseSalienceFlag(flags);
  const outcome = parseChoiceFlag(flags, 'outcome', ['success', 'failure', 'partial']);
  const layer = parseChoiceFlag(flags, 'layer', Object.values(Layer));
  const staged: ReadonlyArray<readonly [RankStage, (() => never) | undefined]> = [
    ['expand', graphHops.fail], ['rerank', reranker.fail], ['salience', salience.fail], ['outcome', outcome.fail], ['layer', layer.fail],
  ];
  let error: LateFlagError | undefined;
  for (const [stage, fail] of staged) {
    if (fail) { error = { stage, fail }; break; }
  }
  return {
    graphHops: graphHops.value,
    reranker: reranker.value,
    salienceThreshold: salience.value,
    outcome: outcome.value,
    layer: layer.value,
    error,
  };
}

/** Runs `hippo recall`: the flags name the ranking core and this verb's presenter, `retrieve` ranks and records, then the block prints. */
export async function cmdRecall(
  hippoRoot: string,
  query: string,
  flags: CliFlags
): Promise<void> {
  requireInit(hippoRoot);
  const o = parseRecallOptions(hippoRoot, flags);
  const priced = priceRecallEntries(hippoRoot, query, o);
  const slot: PresentedSlot = {};
  await api.retrieve(
    { hippoRoot, tenantId: o.tenantId, actor: api.adminActor('cli') },
    {
      query,
      goalTag: o.goalTag,
      sessionId: o.sessionId,
      cliCore: {
        rank: rankOptions(query, flags, o, priced),
        // The global store is a second source for this surface alone, and never when it is the store being searched.
        sources: { globalRoot: o.globalRoot !== hippoRoot && priced.globalOn ? o.globalRoot : undefined },
        note: (line) => printError(line),
        hostSessionId: hostSessionId(),
        show: (rank, planning) => {
          slot.presented = presentRecall(hippoRoot, query, o, { rank, ...priced }, planning);
          return slot.presented.shown;
        },
      },
    },
  );
  // A late flag is rejected where the ranking halted, after the notes its earlier stages printed.
  o.late.error?.fail();
  if (!slot.presented) throw new Error('recall ranked but presented nothing');
  const { fit, text } = slot.presented;
  const { results, hints } = fit;
  // Fed after the final detect, so the next recall's cooldown reads the top row and hint this one showed.
  if (fit.anchorRing) noteRecall(fit.anchorRing, query, results[0]?.entry.id ?? null, hints.anchoring?.memoryId);
  console.log(text);
}

/** Every flag recall reads, parsed in the order the single-body command checked them. */
function parseRecallOptions(hippoRoot: string, flags: CliFlags) {
  const budget = parseBudgetFlag(flags['budget'], DEFAULT_RECALL_BUDGET);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = boolFlag(flags, 'json');
  const showWhy = boolFlag(flags, 'why');
  const includeSuperseded = boolFlag(flags, 'include-superseded');
  const asOf = parseAsOfFlag(flags);
  const globalRoot = getGlobalRoot();
  const primaryIsGlobal = isGlobalStoreRoot(hippoRoot);
  // Cross-tenant rows must never surface, so the tenant is resolved once and threaded through every load.
  const tenantId = resolveTenantId({});
  // The explicit --scope is the filter input; the detected scope only boosts, so auto-detection never filters.
  const explicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const config = loadConfig(hippoRoot);
  const minResults = flags['min-results'] !== undefined
    ? parseInt(String(flags['min-results']), 10)
    : undefined;
  const activeScope = explicitScope || detectScope();
  const graphStream = flagIsTrue(flags, 'graph-stream') ? parseGraphStreamFlags(flags) : undefined;
  const late = parseRecallLateFlags(flags);
  const goalTag = flags['goal'] !== undefined ? String(flags['goal']).trim() : '';
  const sessionId = (
    flags['session-id'] !== undefined
      ? String(flags['session-id'])
      : envHippoSessionId() ?? ''
  ).trim();
  return {
    budget, limit, asJson, showWhy, includeSuperseded, asOf, globalRoot, primaryIsGlobal, tenantId,
    explicitScope, config, minResults, activeScope, graphStream, late, goalTag, sessionId,
    includeContinuity: boolFlag(flags, 'continuity'),
  };
}

type RecallOptions = ReturnType<typeof parseRecallOptions>;

/** Each entry priced as the line it prints, with the source marker `--why` shows. */
function priceRecallEntries(hippoRoot: string, query: string, o: RecallOptions) {
  const localIndex = loadIndex(hippoRoot);
  const globalOn = isInitialized(o.globalRoot);
  const isGlobal = (r: SearchResult): boolean => o.primaryIsGlobal || (globalOn && !localIndex.entries[r.entry.id]);
  const entryText = (r: SearchResult): string => recallEntryText(r, query, o.showWhy, isGlobal(r));
  const printCost = (r: SearchResult): number => printedTokens(entryText(r));
  return { globalOn, isGlobal, entryText, printCost };
}

type PricedEntries = ReturnType<typeof priceRecallEntries>;

/** The ranking core's options; a late flag error halts it before the stage that reads the flag. */
function rankOptions(query: string, flags: CliFlags, o: RecallOptions, priced: PricedEntries): api.CliCoreRecall['rank'] {
  // Engines spend the budget on the text each result prints as, less the header, so selection and print agree.
  const entryBudget = Math.max(0, o.budget - printedTokens(recallHeading(o.budget, o.budget, query)));
  return {
    budget: entryBudget, cost: priced.printCost, limit: o.limit, why: o.showWhy, includeSuperseded: o.includeSuperseded, asOf: o.asOf,
    explicitScope: o.explicitScope, activeScope: o.activeScope,
    search: { ...engineFlags(flags, o.config), multihop: flagIsTrue(flags, 'multihop') || o.config.multihop.enabled, graphStream: o.graphStream, minResults: o.minResults, explain: false },
    graphHops: o.late.graphHops,
    evcAdaptive: boolFlag(flags, 'evc-adaptive'),
    filterConflicts: boolFlag(flags, 'filter-conflicts'),
    valueAware: boolFlag(flags, 'value-aware'),
    rerankUtility: boolFlag(flags, 'rerank-utility'),
    reranker: o.late.reranker,
    salienceThreshold: o.late.salienceThreshold,
    outcome: o.late.outcome,
    layer: o.late.layer,
    haltBefore: o.late.error?.stage,
  };
}

interface RankedRecall extends PricedEntries {
  readonly rank: RankRecallResult;
}

interface RecallContinuity {
  readonly activeSnapshot: TaskSnapshot | null;
  readonly sessionHandoff: SessionHandoff | null;
  readonly recentSessionEvents: SessionEvent[];
}

/** Loaded before the zero-result branch, so a no-match query with live continuity still returns a resume packet. */
function loadRecallContinuity(hippoRoot: string, o: RecallOptions): RecallContinuity {
  if (!o.includeContinuity || o.primaryIsGlobal) return { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] };
  const rawSnapshot = loadActiveTaskSnapshot(hippoRoot, o.tenantId);
  const sessionId = rawSnapshot?.session_id ?? undefined;
  const rawHandoff = sessionId
    ? loadLatestHandoff(hippoRoot, o.tenantId, sessionId)
    : null;
  const rawEvents = sessionId
    ? listSessionEvents(hippoRoot, o.tenantId, { session_id: sessionId, limit: 5 })
    : [];
  // The same shared scope rule as api.recall; the active scope merges --scope and detectScope().
  const effectiveScope = o.activeScope || undefined;
  const rowScope = (
    r: { scope?: string | null } | null | undefined,
  ): string | null => r?.scope ?? null;
  return {
    activeSnapshot: rawSnapshot && passesScopeFilterForRecall(rowScope(rawSnapshot), effectiveScope) ? rawSnapshot : null,
    sessionHandoff: rawHandoff && passesScopeFilterForRecall(rowScope(rawHandoff), effectiveScope) ? rawHandoff : null,
    recentSessionEvents: rawEvents.filter((e) => passesScopeFilterForRecall(rowScope(e), effectiveScope)),
  };
}

/** Each pipeline computes its hints over the list it returns, so they follow the list as it shrinks. */
function recallHinter(query: string, o: RecallOptions, rank: RankedRecall['rank']) {
  const { tenantId, sessionId } = o;
  // HIPPO_ANCHORING=off and HIPPO_AVAILABILITY=off skip the work entirely.
  const anchorRing = sessionRing('cli', tenantId, sessionId);
  const queryHash = hashQueryText(query);
  const availabilityPool = biasHintEnabled('availability')
    ? [...rank.localEntries, ...rank.globalEntries].map((e) => ({ id: e.id, created: e.created }))
    : null;
  const hintsFor = (list: SearchResult[], held: number) => {
    const anchoring = anchorRing ? detectAnchoring(snapshotRing(anchorRing), queryHash, list[0]?.entry.id ?? null) : null;
    const availability = availabilityPool
      ? detectAvailabilityBias({ topK: list.map((r) => ({ id: r.entry.id, created: r.entry.created })), pool: availabilityPool })
      : null;
    const summary = api.buildSuppressionSummary({
      // The published total includes graph-surfaced rows, so total == preRank + byBudget + returned holds for callers.
      totalCandidates: rank.totalCandidates + rank.graphAdded,
      droppedPreRank: rank.droppedPreRank + held,
      droppedByBudget: Math.max(0, rank.totalCandidates + rank.graphAdded - rank.droppedPreRank - held - list.length),
      summarySubstitutionsAdded: 0,
      freshTailAdded: 0,
      suppressedByInterference: anchoring?.reason === 'memory_dominance' ? 1 : 0, // a query_repeat is a re-ask, not competition
    });
    return { anchoring, availability, summary };
  };
  return { anchorRing, hintsFor };
}

type RecallHints = ReturnType<ReturnType<typeof recallHinter>['hintsFor']>;

interface RecallRenderView {
  readonly query: string;
  readonly showWhy: boolean;
  readonly showPlan: boolean;
  readonly planText: string | null;
  readonly hasContinuity: boolean;
  readonly continuity: RecallContinuity;
  readonly entryText: (r: SearchResult) => string;
}

function renderRecallBlock(list: SearchResult[], h: RecallHints, v: RecallRenderView): string {
  const { query, showWhy, showPlan, planText, hasContinuity, entryText } = v;
  const { activeSnapshot, sessionHandoff, recentSessionEvents } = v.continuity;
  const printContinuity = (): void => {
    if (activeSnapshot) printActiveTaskSnapshot(activeSnapshot);
    if (sessionHandoff) printHandoff(sessionHandoff);
    if (recentSessionEvents.length > 0) printSessionEvents(recentSessionEvents);
  };
  return settleTokens((t) => captureConsole(() => {
    if (list.length === 0) {
      // The hint still prints when nothing matched, so the agent sees its track record.
      if (showPlan) { console.log(planText); console.log(); }
      if (hasContinuity) {
        printContinuity();
        console.log(`(no memories matched "${query}")`);
      } else {
        console.log('No memories found for:', query);
      }
      return;
    }
    printContinuity();
    // Anchoring is the stronger pull, so it prints first; the Cutoff line sits above the list, where a reader sees it.
    if (h.anchoring) { console.log(`[anchored_on: ${h.anchoring.memoryId}] ${h.anchoring.summary}`); console.log(); }
    if (h.availability) {
      console.log(`Availability bias (${h.availability.recentCount}/${h.availability.returnedCount} recent): ${h.availability.summary}`);
      console.log();
    }
    if (showPlan) { console.log(planText); console.log(); }
    const cutoff = showWhy ? cutoffLine(list.length, h.summary) : null;
    if (cutoff) { console.log(cutoff); console.log(); }
    console.log(recallHeading(list.length, t, query));
    for (const r of list) console.log(entryText(r));
  }));
}

/** Pays the continuity sections and the plan hint first, then fits the memories into what is left. */
function fitRecallBlock(query: string, o: RecallOptions, ranked: RankedRecall, loaded: RecallContinuity, planning: PlanningFallacyOutput) {
  const { budget } = o;
  let { activeSnapshot, sessionHandoff, recentSessionEvents } = loaded;
  // Sections print ahead of the memories, so they are paid first, after the header; one that does not fit is dropped.
  const sectionBudget = budget - printedTokens(recallHeading(budget, budget, query));
  let left = sectionBudget;
  const pays = (tokens: number): boolean => { if (tokens > left) return false; left -= tokens; return true; };
  if (activeSnapshot && !pays(printedTokens(snapshotText(activeSnapshot)))) activeSnapshot = null;
  if (sessionHandoff && !pays(printedTokens(handoffText(sessionHandoff)))) sessionHandoff = null;
  if (recentSessionEvents.length > 0 && !pays(printedTokens(sessionTrailText(recentSessionEvents)))) recentSessionEvents = [];
  const continuityTokens = sectionBudget - left;
  const continuity: RecallContinuity = { activeSnapshot, sessionHandoff, recentSessionEvents };
  const hasContinuity = activeSnapshot !== null || sessionHandoff !== null || recentSessionEvents.length > 0;

  // The baserate hint depends on the query alone, so `retrieve` evaluates it and this only prices the line.
  const planText = planningLine(planning);
  const showPlan = planText !== null && pays(printedTokens(`${planText}\n`));
  const cmdPlanningFallacyHint = showPlan ? planning.hint ?? null : null;
  const cmdPlanningFallacyWatching = showPlan ? planning.watching ?? null : null;

  // The first --min-results are kept whatever they cost (the documented exception); the rest skip and continue.
  const floor = o.minResults ?? 1;
  const fitted = fitBudget(ranked.rank.results, left, floor, ranked.printCost);
  // Copies go after every cut, so a merged row the budget drops never hides its sources.
  const shown = (n: number): SearchResult[] => dropHeldCopies(fitted.slice(0, n), (r) => r.entry);
  let kept = fitted.length;
  let results = shown(kept);

  const { anchorRing, hintsFor } = recallHinter(query, o, ranked.rank);
  const view: RecallRenderView = { query, showWhy: o.showWhy, showPlan, planText, hasContinuity, continuity, entryText: ranked.entryText };
  let hints = hintsFor(results, kept - results.length);
  let recallText = renderRecallBlock(results, hints, view);
  // The hints, Cutoff line and header vary with the list, so the lowest-ranked entry goes until the whole block fits.
  while (kept > floor && estimateTokens(recallText) > budget) {
    kept--;
    results = shown(kept);
    hints = hintsFor(results, kept - results.length);
    recallText = renderRecallBlock(results, hints, view);
  }
  return { results, hints, recallText, continuity, continuityTokens, cmdPlanningFallacyHint, cmdPlanningFallacyWatching, anchorRing };
}

type FittedRecall = ReturnType<typeof fitRecallBlock>;

/** The presenter `retrieve` calls once ranking ends: fits and renders the block, and names the rows and hint rows to record. */
function presentRecall(hippoRoot: string, query: string, o: RecallOptions, ranked: RankedRecall, planning: PlanningFallacyOutput) {
  const fit = fitRecallBlock(query, o, ranked, loadRecallContinuity(hippoRoot, o), planning);
  const { results, hints } = fit;
  const text = recallOutput(query, o, fit, ranked.isGlobal);
  const audit = shownRecallRows({ tenantId: o.tenantId, actor: 'cli' }, {
    query, ring: fit.anchorRing, topId: results[0]?.entry.id ?? null, anchoring: hints.anchoring, availability: hints.availability,
  });
  // The token ledger books the text this recall prints, on whichever exit it takes.
  return { fit, text, shown: { results, audit, tokens: estimateTokens(text) } };
}

type PresentedRecall = ReturnType<typeof presentRecall>;

/** Where the presenter parks what it built; a `let` it assigned would read as never-assigned after the await. */
interface PresentedSlot { presented?: PresentedRecall }

/** What this recall prints: the JSON object, or the fitted block. */
function recallOutput(query: string, o: RecallOptions, fit: FittedRecall, isGlobal: (r: SearchResult) => boolean): string {
  const { asJson, includeContinuity } = o;
  const { results, recallText } = fit;
  if (results.length === 0) {
    // HTTP and MCP surface the hint whatever matched, so the zero-result JSON keeps it for parity.
    return asJson ? JSON.stringify({ query, results: [], total: 0, ...recallJsonTail(fit, includeContinuity) }) : recallText;
  }
  if (!asJson) return recallText;
  const output = results.map((r) => recallJsonRow(r, query, o.showWhy, isGlobal(r)));
  return JSON.stringify({
    query,
    budget: o.budget,
    results: output,
    total: output.length,
    ...recallJsonTail(fit, includeContinuity),
  });
}

/** The JSON keys after the result list: suppression summary, any bias hints, then continuity when asked for. */
function recallJsonTail(fit: FittedRecall, includeContinuity: boolean | undefined) {
  const { cmdPlanningFallacyHint, cmdPlanningFallacyWatching, continuityTokens } = fit;
  const { activeSnapshot, sessionHandoff, recentSessionEvents } = fit.continuity;
  const { anchoring: cmdAnchoringHint, availability: cmdAvailabilityHint, summary: cmdSuppressionSummary } = fit.hints;
  const tail: Record<string, unknown> = {
    suppressionSummary: cmdSuppressionSummary,
    ...(cmdPlanningFallacyHint ? { planningFallacyHint: cmdPlanningFallacyHint } : {}),
    ...(cmdPlanningFallacyWatching ? { planningFallacyWatching: cmdPlanningFallacyWatching } : {}),
    ...(cmdAnchoringHint ? { anchoringHint: cmdAnchoringHint } : {}),
    ...(cmdAvailabilityHint ? { availabilityHint: cmdAvailabilityHint } : {}),
  };
  if (includeContinuity) {
    tail.continuity = {
      activeSnapshot,
      sessionHandoff,
      recentSessionEvents,
    };
    tail.continuityTokens = continuityTokens;
  }
  return tail;
}

function recallJsonRow(r: SearchResult, query: string, showWhy: boolean, isGlobal: boolean) {
  const base: Record<string, unknown> = {
    id: r.entry.id,
    score: r.score,
    strength: r.entry.strength,
    tokens: r.tokens,
    tags: r.entry.tags,
    content: r.entry.content,
    layer: r.entry.layer,
  };
  if (r.entry.layer === Layer.Trace) {
    base.trace_outcome = r.entry.trace_outcome;
  }
  if (r.entry.superseded_by) {
    base.superseded = true;
    base.superseded_by = r.entry.superseded_by;
  }
  if (r.graphVia) {
    base.graphVia = r.graphVia;
  }
  if (showWhy) {
    const explanation = explainMatch(query, r);
    const facets = confidenceFacets(r.entry);
    base.confidence = facets.tier;
    base.aged_out = facets.agedOut;
    base.source = isGlobal ? 'global' : 'local';
    base.reason = explanation.reason;
    base.bm25 = r.bm25;
    base.cosine = r.cosine;
    if (explanation.envelope) {
      base.envelope = explanation.envelope;
    }
    // The ordered lifecycle re-ranking steps, so a caller can see why a row moved.
    if (r.rerankTrace && r.rerankTrace.length > 0) {
      base.rerankTrace = r.rerankTrace;
    }
  }
  return base;
}

export async function handleRecall({ hippoRoot, args, flags }: CommandContext): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    printError('Please provide a search query.');
    process.exit(1);
  }
  await cmdRecall(hookStoreRoot(hippoRoot), query, flags);
}
