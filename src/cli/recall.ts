// The `hippo recall` verb; main() loads it lazily from the command table.

import { confidenceFacets, Layer } from '../memory.js';
import { TaskSnapshot, SessionEvent } from '../store/rows.js';
import { isInitialized } from '../store/open.js';
import { strengthenRetrieved } from '../store/entry-writes.js';
import { loadIndex, saveIndex, updateStats } from '../store/index-and-stats.js';
import { loadActiveTaskSnapshot, listSessionEvents } from '../store/sessions.js';
import { loadLatestHandoff } from '../store/handoffs.js';
import type { SessionHandoff } from '../handoff.js';
import { passesScopeFilterForRecall } from '../recall-scope.js';
import { fitBudget } from '../search/finalize.js';
import { explainMatch } from '../search/explain.js';
import type { SearchResult } from '../search/types.js';
import { writeRecallTraceAtRoot } from '../recall-trace.js';
import { loadConfig } from '../config.js';
import { openHippoDb, closeHippoDb } from '../db.js';
import { estimateTokens, recordTokenUse } from '../token-ledger.js';
import { writeGoalRecallLog } from '../goals.js';
import { dropHeldCopies } from '../same-text.js';
import { isGlobalStoreRoot } from '../project-identity.js';
import { detectScope } from '../scope.js';
import { getGlobalRoot } from '../shared.js';
import { auditQueryFields } from '../audit.js';
import * as api from '../api.js';
import { computePlanningFallacyOutput, type PlanningFallacyOutput } from '../predictions/planning-fallacy.js';
import {
  detectAnchoring,
  hashQueryText,
  biasHintEnabled,
  buildSessionKey,
  getOrCreateRing,
  appendRecall,
  snapshotRing,
  RingBuffer,
} from '../recall-history.js';
import { detectAvailabilityBias } from '../availability.js';
import { resolveTenantId } from '../tenant.js';
import { MAX_HOPS, DEFAULT_MAX_NEIGHBORS } from '../graph-recall.js';
import { getReranker } from '../rerankers/index.js';
import type { RerankerFn } from '../rerankers/types.js';
import {
  rankRecall,
  type RankStage,
  type RecallGraphHops,
  type RecallGraphStream,
  type RecallReranker,
} from '../recall-pipeline.js';
import { JEV_DEFAULT_TOP_K } from '../rerankers/jev.js';
import { isClefModel } from '../rerankers/clef.js';
import { handoffText, printedTokens, sessionTrailText, settleTokens, snapshotText } from '../context-render.js';
import { printError } from './output.js';
import {
  parseLimitFlag,
  parseBudgetFlag,
  emitCliAudit,
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
  withLedgerDb,
} from './shared.js';

// Per-process rings: a single-shot `hippo recall` starts empty, so anchoring only accumulates in long-lived
// hosts (in-process loops, `hippo serve`, the MCP server).
const sessionRecallHistoryCli = new Map<string, RingBuffer>();

/** Test-only: reset the module-level recall-history Map. Call from beforeEach. */
export function __resetSessionRecallHistoryCli(): void {
  sessionRecallHistoryCli.clear();
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

/** Runs `hippo recall`: parse, rank, load continuity, fit the printed block to the budget, audit, then write and print. */
export async function cmdRecall(
  hippoRoot: string,
  query: string,
  flags: CliFlags
): Promise<void> {
  requireInit(hippoRoot);
  const o = parseRecallOptions(hippoRoot, flags);
  const ranked = await rankForRecall(hippoRoot, query, flags, o);
  const fit = fitRecallBlock(hippoRoot, query, o, ranked, loadRecallContinuity(hippoRoot, o));
  auditRecall(hippoRoot, o.globalRoot, query, fit);
  writeRecallResult(hippoRoot, query, o, fit, ranked.localIndex);
}

/** Every flag recall reads, parsed in the order the single-body command checked them. */
function parseRecallOptions(hippoRoot: string, flags: CliFlags) {
  const budget = parseBudgetFlag(flags['budget'], 4000);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = Boolean(flags['json']);
  const showWhy = Boolean(flags['why']);
  const includeSuperseded = Boolean(flags['include-superseded']);
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
  const graphStream = flags['graph-stream'] === true ? parseGraphStreamFlags(flags) : undefined;
  const late = parseRecallLateFlags(flags);
  const goalTag = flags['goal'] !== undefined ? String(flags['goal']).trim() : '';
  const sessionId = (
    flags['session-id'] !== undefined
      ? String(flags['session-id'])
      : process.env.HIPPO_SESSION_ID ?? ''
  ).trim();
  return {
    budget, limit, asJson, showWhy, includeSuperseded, asOf, globalRoot, primaryIsGlobal, tenantId,
    explicitScope, config, minResults, activeScope, graphStream, late, goalTag, sessionId,
    includeContinuity: Boolean(flags['continuity']),
  };
}

type RecallOptions = ReturnType<typeof parseRecallOptions>;

/** Ranks against each entry's printed cost, then rejects a late flag at the stage where the pipeline halted. */
async function rankForRecall(hippoRoot: string, query: string, flags: CliFlags, o: RecallOptions) {
  // Engines spend the budget on the text each result prints as, less the header, so selection and print agree.
  const localIndex = loadIndex(hippoRoot);
  const globalOn = isInitialized(o.globalRoot);
  const entryText = (r: SearchResult): string => recallEntryText(r, query, o.showWhy, o.primaryIsGlobal || (globalOn && !localIndex.entries[r.entry.id]));
  const printCost = (r: SearchResult): number => printedTokens(entryText(r));
  const entryBudget = Math.max(0, o.budget - printedTokens(recallHeading(o.budget, o.budget, query)));

  const rank = await rankRecall(
    { hippoRoot, globalRoot: o.globalRoot !== hippoRoot && globalOn ? o.globalRoot : undefined, tenantId: o.tenantId, note: (line) => printError(line) },
    {
      query, budget: entryBudget, cost: printCost, limit: o.limit, why: o.showWhy, includeSuperseded: o.includeSuperseded, asOf: o.asOf,
      explicitScope: o.explicitScope, activeScope: o.activeScope,
      search: { ...engineFlags(flags, o.config), multihop: flags['multihop'] === true || o.config.multihop.enabled, graphStream: o.graphStream, minResults: o.minResults, explain: false },
      graphHops: o.late.graphHops,
      evcAdaptive: Boolean(flags['evc-adaptive']),
      filterConflicts: Boolean(flags['filter-conflicts']),
      valueAware: Boolean(flags['value-aware']),
      rerankUtility: Boolean(flags['rerank-utility']),
      reranker: o.late.reranker,
      goalTag: o.goalTag,
      sessionId: o.sessionId,
      salienceThreshold: o.late.salienceThreshold,
      outcome: o.late.outcome,
      layer: o.late.layer,
      haltBefore: o.late.error?.stage,
    },
  );
  if (rank.goalRecallLog.length > 0) {
    const dbForGoals = openHippoDb(hippoRoot);
    try {
      writeGoalRecallLog(dbForGoals, rank.goalRecallLog);
    } finally {
      closeHippoDb(dbForGoals);
    }
  }
  o.late.error?.fail();
  return { rank, localIndex, entryText, printCost };
}

type RankedRecall = Awaited<ReturnType<typeof rankForRecall>>;

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
  const anchorRing = biasHintEnabled('anchoring') && sessionId
    ? getOrCreateRing(sessionRecallHistoryCli, buildSessionKey(tenantId, sessionId))
    : null;
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
  return { anchorRing, queryHash, hintsFor };
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
function fitRecallBlock(hippoRoot: string, query: string, o: RecallOptions, ranked: RankedRecall, loaded: RecallContinuity) {
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

  // The baserate hint depends on the query alone; its audit is pipeline-local (actor 'cli').
  const cmdPlanningFallacyOutput = computePlanningFallacyOutput(hippoRoot, o.tenantId, query, { actor: 'cli' });
  const planText = planningLine(cmdPlanningFallacyOutput);
  const showPlan = planText !== null && pays(printedTokens(`${planText}\n`));
  const cmdPlanningFallacyHint = showPlan ? cmdPlanningFallacyOutput.hint ?? null : null;
  const cmdPlanningFallacyWatching = showPlan ? cmdPlanningFallacyOutput.watching ?? null : null;

  // The first --min-results are kept whatever they cost (the documented exception); the rest skip and continue.
  const floor = o.minResults ?? 1;
  const fitted = fitBudget(ranked.rank.results, left, floor, ranked.printCost);
  // Copies go after every cut, so a merged row the budget drops never hides its sources.
  const shown = (n: number): SearchResult[] => dropHeldCopies(fitted.slice(0, n), (r) => r.entry);
  let kept = fitted.length;
  let results = shown(kept);

  const { anchorRing, queryHash, hintsFor } = recallHinter(query, o, ranked.rank);
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
  return { results, hints, recallText, continuity, continuityTokens, cmdPlanningFallacyHint, cmdPlanningFallacyWatching, anchorRing, queryHash };
}

type FittedRecall = ReturnType<typeof fitRecallBlock>;

function auditRecall(hippoRoot: string, globalRoot: string, query: string, fit: FittedRecall): void {
  const { results, anchorRing, queryHash } = fit;
  const { anchoring: cmdAnchoringHint, availability: cmdAvailabilityHint } = fit.hints;
  if (anchorRing) {
    // Appended after every detect: anchoredOn feeds the cooldown for the next recall on this session.
    appendRecall(anchorRing, queryHash, results[0]?.entry.id ?? null, cmdAnchoringHint?.memoryId);
  } else if (biasHintEnabled('anchoring')) {
    // SHA-256/16 per the recall-audit convention; hashQueryText is FNV-1a and brute-forceable on short queries.
    emitCliAudit(hippoRoot, 'recall_anchor_skipped_no_session', undefined, auditQueryFields(query));
  }
  if (cmdAnchoringHint?.reason === 'memory_dominance') {
    emitCliAudit(hippoRoot, 'recall_anchor_detected_memory_dominance', cmdAnchoringHint.memoryId, {
      memory_id: cmdAnchoringHint.memoryId,
      query_count: cmdAnchoringHint.queryCount ?? null,
    });
  } else if (cmdAnchoringHint?.reason === 'query_repeat') {
    emitCliAudit(hippoRoot, 'recall_anchor_detected_query_repeat', cmdAnchoringHint.memoryId, {
      memory_id: cmdAnchoringHint.memoryId,
    });
  }
  if (cmdAvailabilityHint) {
    emitCliAudit(hippoRoot, 'recall_availability_detected', undefined, {
      recent_fraction: cmdAvailabilityHint.recentFraction,
      older_passed_over: cmdAvailabilityHint.olderCandidatesPassedOver,
      returned_count: cmdAvailabilityHint.returnedCount,
    });
  }

  // One 'recall' event per query, before the early-empty return, in every participating store.
  const recallMetadata: Record<string, unknown> = {
    ...auditQueryFields(query),
    results: results.length,
  };
  emitCliAudit(hippoRoot, 'recall', undefined, recallMetadata);
  if (isInitialized(globalRoot) && globalRoot !== hippoRoot) {
    emitCliAudit(globalRoot, 'recall', undefined, recallMetadata);
  }
}

/** Traces the recall, books retrieval for a non-empty list, then prints JSON or the fitted block. */
function writeRecallResult(hippoRoot: string, query: string, o: RecallOptions, fit: FittedRecall, localIndex: RankedRecall['localIndex']): void {
  const { tenantId, sessionId, showWhy, asJson, includeContinuity } = o;
  const { results, recallText, cmdPlanningFallacyHint, cmdPlanningFallacyWatching, continuityTokens } = fit;
  const { activeSnapshot, sessionHandoff, recentSessionEvents } = fit.continuity;
  const { anchoring: cmdAnchoringHint, availability: cmdAvailabilityHint, summary: cmdSuppressionSummary } = fit.hints;
  // The token ledger books the block this recall prints, on whichever exit it takes.
  const emit = (text: string): void => {
    withLedgerDb(hippoRoot, (db) => recordTokenUse(db, {
      tenantId,
      sessionId: hostSessionId() ?? null,
      surface: 'recall',
      event: 'inject',
      items: results.length,
      tokens: estimateTokens(text),
    }));
    console.log(text);
  };

  if (results.length === 0) {
    // Traced too, so a coverage gap still lands in the training corpus; this path never touches localIndex.
    writeRecallTraceAtRoot(hippoRoot, {
      tenantId,
      sessionId: sessionId || hostSessionId() || null,
      pipeline: 'cli',
      query,
      explainMode: showWhy,
      results: [],
    });

    if (asJson) {
      const out: Record<string, unknown> = {
        query,
        results: [],
        total: 0,
        suppressionSummary: cmdSuppressionSummary,
        // HTTP and MCP surface the hint whatever matched, so the zero-result JSON keeps it for parity.
        ...(cmdPlanningFallacyHint ? { planningFallacyHint: cmdPlanningFallacyHint } : {}),
        ...(cmdPlanningFallacyWatching ? { planningFallacyWatching: cmdPlanningFallacyWatching } : {}),
        ...(cmdAnchoringHint ? { anchoringHint: cmdAnchoringHint } : {}),
        ...(cmdAvailabilityHint ? { availabilityHint: cmdAvailabilityHint } : {}),
      };
      if (includeContinuity) {
        out.continuity = {
          activeSnapshot,
          sessionHandoff,
          recentSessionEvents,
        };
        out.continuityTokens = continuityTokens;
      }
      emit(JSON.stringify(out));
      return;
    }
    emit(recallText);
    return;
  }

  recordRetrieval(hippoRoot, query, o, results, localIndex);

  if (asJson) {
    const output = results.map((r) => recallJsonRow(r, query, showWhy, o.primaryIsGlobal || (isInitialized(o.globalRoot) && !localIndex.entries[r.entry.id])));
    const jsonOut: Record<string, unknown> = {
      query,
      budget: o.budget,
      results: output,
      total: output.length,
      suppressionSummary: cmdSuppressionSummary,
      ...(cmdPlanningFallacyHint ? { planningFallacyHint: cmdPlanningFallacyHint } : {}),
      ...(cmdPlanningFallacyWatching ? { planningFallacyWatching: cmdPlanningFallacyWatching } : {}),
      ...(cmdAnchoringHint ? { anchoringHint: cmdAnchoringHint } : {}),
      ...(cmdAvailabilityHint ? { availabilityHint: cmdAvailabilityHint } : {}),
    };
    if (includeContinuity) {
      jsonOut.continuity = {
        activeSnapshot,
        sessionHandoff,
        recentSessionEvents,
      };
      jsonOut.continuityTokens = continuityTokens;
    }
    emit(JSON.stringify(jsonOut));
    return;
  }
  emit(recallText);
}

/** Strengthens the returned rows and persists last_retrieval_ids and last_trace_id in one saveIndex call. */
function recordRetrieval(hippoRoot: string, query: string, o: RecallOptions, results: SearchResult[], localIndex: RankedRecall['localIndex']): void {
  const { globalRoot, tenantId, sessionId, showWhy } = o;
  const retrievedIds = results.map((r) => r.entry.id);
  const strengthenedHere = strengthenRetrieved(hippoRoot, retrievedIds);
  if (isInitialized(globalRoot)) strengthenRetrieved(globalRoot, retrievedIds.filter((id) => !strengthenedHere.has(id)));

  // Track last retrieval IDs for outcome command
  localIndex.last_retrieval_ids = retrievedIds;

  // One trace at hippoRoot, where outcome attribution lives, written first so the same saveIndex keeps
  // last_retrieval_ids and last_trace_id in lockstep (see writeRecallTraceAtRoot). Fail-soft; never throws.
  const traceId = writeRecallTraceAtRoot(hippoRoot, {
    tenantId,
    sessionId: sessionId || hostSessionId() || null,
    pipeline: 'cli',
    query,
    explainMode: showWhy,
    results: results.map((r) => ({
      memoryId: r.entry.id,
      score: r.score,
      rerankSteps: r.rerankTrace,
    })),
  });
  localIndex.last_trace_id = traceId !== null ? String(traceId) : null;
  saveIndex(hippoRoot, localIndex);

  updateStats(hippoRoot, { recalled: results.length });
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
