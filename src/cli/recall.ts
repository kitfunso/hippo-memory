// The `hippo recall` verb; main() loads it lazily from the command table.

import { envHippoSessionId } from '../util/env.js';
import { Layer } from '../core/memory.js';
import { DEFAULT_RECALL_BUDGET, type SearchResult } from '../core/search-types.js';
import { loadConfig } from '../core/config.js';
import { estimateTokens } from '../util/token-text.js';
import { dropHeldCopies } from '../util/same-text.js';
import * as api from '../api/index.js';
import type { PlanningFallacyOutput } from '../predictions/planning-fallacy.js';
import { detectAnchoring, hashQueryText, biasHintEnabled, snapshotRing } from '../api/recall-history.js';
import { sessionRing, shownRecallRows } from '../api/recall-record.js';
import { detectAvailabilityBias } from '../api/availability.js';
import {
  cliRecallOrigin, cliRecallReranker, cliRecallSetting, DEFAULT_MAX_NEIGHBORS, fitRecallRows, loadCliRecallContinuity, MAX_HOPS, recallJsonRow,
  type CliRecallRerankerPick,
} from '../api/recall-cli.js';
import { cliApiContext } from './api-context.js';
import type { RankRecallResult, RankStage, RecallGraphHops, RecallGraphStream, RecallReranker } from '../api/recall-pipeline.js';
import { handoffText, printedTokens, sessionTrailText, settleTokens, snapshotText } from '../api/context-render.js';
import { printError } from './output.js';
import {
  parseLimitFlag, parseBudgetFlag, type CliFlags, type CommandContext, parseAsOfFlag, engineFlags, boolFlag, flagIsTrue, isBooleanFlag,
} from './flag-values.js';
import { requireInit } from './shared.js';
import { recallEntryText, recallHeading, printActiveTaskSnapshot, printSessionEvents, printHandoff, captureConsole } from './print.js';
import { hostSessionId, hookStoreRoot } from './hook-runtime.js';
import { CliExit } from './exit.js';

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
    throw new CliExit(1);
  };
}

/** `--graph-stream` implies rrf fusion as well as the graph stream; the CLI fuses the local store only. */
function parseGraphStreamFlags(flags: CliFlags): RecallGraphStream {
  let hops: number | undefined;
  if (flags['graph-hops'] !== undefined) {
    if (isBooleanFlag(flags['graph-hops'])) failWith(`--graph-hops requires an integer value 1..${MAX_HOPS} (e.g. --graph-hops 2).`)();
    const h = Number(flags['graph-hops']);
    if (!Number.isInteger(h) || h < 1 || h > MAX_HOPS) {
      failWith(`Invalid --graph-hops: "${String(flags['graph-hops'])}". Must be an integer 1..${MAX_HOPS}.`)();
    }
    hops = h;
  }
  let seeds: number | undefined;
  if (flags['graph-seeds'] !== undefined) {
    if (isBooleanFlag(flags['graph-seeds'])) failWith('--graph-seeds requires a positive integer value (e.g. --graph-seeds 10).')();
    const s = Number(flags['graph-seeds']);
    if (!Number.isInteger(s) || s < 1) failWith(`Invalid --graph-seeds: "${String(flags['graph-seeds'])}". Must be a positive integer.`)();
    seeds = s;
  }
  return { hops, seeds };
}

function parseHopsFlags(flags: CliFlags): ParsedFlag<RecallGraphHops> {
  if (flags['hops'] === undefined) return {};
  // A value-less `--hops` parses as true, and Number(true) === 1 would silently run a 1-hop expansion.
  if (isBooleanFlag(flags['hops'])) return { fail: failWith(`--hops requires an integer value 0..${MAX_HOPS} (e.g. --hops 1).`) };
  const hops = Number(flags['hops']);
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_HOPS) {
    return { fail: failWith(`Invalid --hops: "${String(flags['hops'])}". Must be an integer 0..${MAX_HOPS}.`) };
  }
  const raw = flags['max-neighbors'];
  if (raw === undefined) return { value: { hops, maxNeighbors: DEFAULT_MAX_NEIGHBORS } };
  if (isBooleanFlag(raw)) return { fail: failWith(`--max-neighbors requires an integer value 1..200.`) };
  const maxNeighbors = Number(raw);
  if (!Number.isInteger(maxNeighbors) || maxNeighbors < 1 || maxNeighbors > 200) {
    return { fail: failWith(`Invalid --max-neighbors: "${String(raw)}". Must be an integer 1..200.`) };
  }
  return { value: { hops, maxNeighbors } };
}

function parseRerankerFlag(flags: CliFlags): ParsedFlag<RecallReranker> {
  const name = flags['reranker'] !== undefined ? String(flags['reranker']).trim() : '';
  let picked: CliRecallRerankerPick | null;
  try {
    picked = cliRecallReranker(name);
  } catch (err) {
    // An unknown name throws to the top-level handler, as it did when the lookup sat mid-pipeline.
    return { fail: () => { throw err; } };
  }
  if (!picked) return {};
  const { fn } = picked;
  const raw = flags['reranker-top-k'];
  const topK = raw !== undefined ? Number(raw) : picked.defaultTopK;
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
  tenantId: string,
  query: string,
  flags: CliFlags
): Promise<void> {
  requireInit(hippoRoot);
  const ctx = cliApiContext(hippoRoot, tenantId);
  const o = parseRecallOptions(ctx, flags);
  const priced = priceRecallEntries(ctx, query, o);
  const { globalRoot } = o.setting;
  const slot: PresentedSlot = {};
  await api.retrieve(
    ctx,
    {
      query,
      goalTag: o.goalTag,
      sessionId: o.sessionId,
      cliCore: {
        rank: rankOptions(query, flags, o, priced),
        // The global store is a second source for this surface alone, and never when it is the store being searched.
        sources: { globalRoot: globalRoot !== hippoRoot && priced.globalOn ? globalRoot : undefined },
        note: (line) => printError(line),
        hostSessionId: hostSessionId(),
        show: (rank, planning) => {
          slot.presented = presentRecall(ctx, query, o, { rank, ...priced }, planning);
          return slot.presented.shown;
        },
      },
    },
  );
  // A late flag is rejected where the ranking halted, after the notes its earlier stages printed.
  o.late.error?.fail();
  if (!slot.presented) throw new Error('recall ranked but presented nothing');
  console.log(slot.presented.text);
}

/** Every flag recall reads, parsed in the order the single-body command checked them. */
function parseRecallOptions(ctx: api.HippoDbContext, flags: CliFlags) {
  const budget = parseBudgetFlag(flags['budget'], DEFAULT_RECALL_BUDGET);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = boolFlag(flags, 'json');
  const showWhy = boolFlag(flags, 'why');
  const includeSuperseded = boolFlag(flags, 'include-superseded');
  const asOf = parseAsOfFlag(flags);
  // The explicit --scope is the filter input; the detected scope only boosts, so auto-detection never filters.
  const explicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const setting = cliRecallSetting(ctx, explicitScope);
  const config = loadConfig(ctx.hippoRoot);
  const minResults = flags['min-results'] !== undefined
    ? parseInt(String(flags['min-results']), 10)
    : undefined;
  const graphStream = flagIsTrue(flags, 'graph-stream') ? parseGraphStreamFlags(flags) : undefined;
  const late = parseRecallLateFlags(flags);
  const goalTag = flags['goal'] !== undefined ? String(flags['goal']).trim() : '';
  const sessionId = (
    flags['session-id'] !== undefined
      ? String(flags['session-id'])
      : envHippoSessionId() ?? ''
  ).trim();
  return {
    budget, limit, asJson, showWhy, includeSuperseded, asOf, setting, tenantId: ctx.tenantId,
    explicitScope, config, minResults, graphStream, late, goalTag, sessionId,
    includeContinuity: boolFlag(flags, 'continuity'),
  };
}

type RecallOptions = ReturnType<typeof parseRecallOptions>;

/** Each entry priced as the line it prints, with the source marker `--why` shows. */
function priceRecallEntries(ctx: api.HippoDbContext, query: string, o: RecallOptions) {
  const origin = cliRecallOrigin(ctx, o.setting);
  const isGlobal = (r: SearchResult): boolean => origin.isGlobal(r.entry.id);
  const entryText = (r: SearchResult): string => recallEntryText(r, query, o.showWhy, isGlobal(r));
  const printCost = (r: SearchResult): number => printedTokens(entryText(r));
  return { globalOn: origin.globalOn, isGlobal, entryText, printCost };
}

type PricedEntries = ReturnType<typeof priceRecallEntries>;

/** The ranking core's options; a late flag error halts it before the stage that reads the flag. */
function rankOptions(query: string, flags: CliFlags, o: RecallOptions, priced: PricedEntries): api.CliCoreRecall['rank'] {
  // Engines spend the budget on the text each result prints as, less the header, so selection and print agree.
  const entryBudget = Math.max(0, o.budget - printedTokens(recallHeading(o.budget, o.budget, query)));
  return {
    budget: entryBudget, cost: priced.printCost, limit: o.limit, why: o.showWhy, includeSuperseded: o.includeSuperseded, asOf: o.asOf,
    explicitScope: o.explicitScope, activeScope: o.setting.activeScope,
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
    const summary: api.RecallSuppressionSummary = {
      // The published total includes graph-surfaced rows, so total == preRank + byBudget + returned holds for callers.
      totalCandidates: rank.totalCandidates + rank.graphAdded,
      droppedPreRank: rank.droppedPreRank + held,
      droppedByBudget: Math.max(0, rank.totalCandidates + rank.graphAdded - rank.droppedPreRank - held - list.length),
      summarySubstitutionsAdded: 0,
      freshTailAdded: 0,
      suppressedByInterference: anchoring?.reason === 'memory_dominance' ? 1 : 0, // a query_repeat is a re-ask, not competition
    };
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
  readonly continuity: api.ContinuityBlock;
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
function fitRecallBlock(query: string, o: RecallOptions, ranked: RankedRecall, loaded: api.ContinuityBlock, planning: PlanningFallacyOutput) {
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
  const continuity: api.ContinuityBlock = { activeSnapshot, sessionHandoff, recentSessionEvents };
  const hasContinuity = activeSnapshot !== null || sessionHandoff !== null || recentSessionEvents.length > 0;

  // The baserate hint depends on the query alone, so `retrieve` evaluates it and this only prices the line.
  const planText = planningLine(planning);
  const showPlan = planText !== null && pays(printedTokens(`${planText}\n`));
  const cmdPlanningFallacyHint = showPlan ? planning.hint ?? null : null;
  const cmdPlanningFallacyWatching = showPlan ? planning.watching ?? null : null;

  // The first --min-results are kept whatever they cost (the documented exception); the rest skip and continue.
  const floor = o.minResults ?? 1;
  const fitted = fitRecallRows(ranked.rank.results, left, floor, ranked.printCost);
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
function presentRecall(ctx: api.HippoDbContext, query: string, o: RecallOptions, ranked: RankedRecall, planning: PlanningFallacyOutput) {
  // Loaded before the zero-result branch, so a no-match query with live continuity still returns a resume packet.
  const fit = fitRecallBlock(query, o, ranked, loadCliRecallContinuity(ctx, o.setting, o.includeContinuity), planning);
  const { results, hints } = fit;
  const text = recallOutput(query, o, fit, ranked.isGlobal);
  const audit = shownRecallRows({ tenantId: o.tenantId, actor: 'cli' }, {
    query, ring: fit.anchorRing, topId: results[0]?.entry.id ?? null, anchoring: hints.anchoring, availability: hints.availability,
  });
  // The token ledger books the text this recall prints, on whichever exit it takes; the ring keeps the hint the final detect made.
  return { text, shown: { results, audit, tokens: estimateTokens(text), anchoredOn: hints.anchoring?.memoryId } };
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

/** The keys are set in the order the JSON prints them. */
interface RecallJsonTail {
  suppressionSummary: FittedRecall['hints']['summary'];
  planningFallacyHint?: NonNullable<FittedRecall['cmdPlanningFallacyHint']>;
  planningFallacyWatching?: NonNullable<FittedRecall['cmdPlanningFallacyWatching']>;
  anchoringHint?: NonNullable<FittedRecall['hints']['anchoring']>;
  availabilityHint?: NonNullable<FittedRecall['hints']['availability']>;
  continuity?: api.ContinuityBlock;
  continuityTokens?: number;
}

/** The JSON keys after the result list: suppression summary, any bias hints, then continuity when asked for. */
function recallJsonTail(fit: FittedRecall, includeContinuity: boolean | undefined): RecallJsonTail {
  const { cmdPlanningFallacyHint, cmdPlanningFallacyWatching, continuityTokens } = fit;
  const { activeSnapshot, sessionHandoff, recentSessionEvents } = fit.continuity;
  const { anchoring: cmdAnchoringHint, availability: cmdAvailabilityHint, summary: cmdSuppressionSummary } = fit.hints;
  const tail: RecallJsonTail = { suppressionSummary: cmdSuppressionSummary };
  if (cmdPlanningFallacyHint) tail.planningFallacyHint = cmdPlanningFallacyHint;
  if (cmdPlanningFallacyWatching) tail.planningFallacyWatching = cmdPlanningFallacyWatching;
  if (cmdAnchoringHint) tail.anchoringHint = cmdAnchoringHint;
  if (cmdAvailabilityHint) tail.availabilityHint = cmdAvailabilityHint;
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

export async function handleRecall({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    printError('Please provide a search query.');
    throw new CliExit(1);
  }
  await cmdRecall(hookStoreRoot(hippoRoot), tenantId, query, flags);
}
