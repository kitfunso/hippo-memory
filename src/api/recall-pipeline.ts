// Ranking core shared by `hippo recall` and `hippo explain`: load, search, expand, re-rank and filter, with no
// writes and no direct output. Callers own flag parsing, printing, budget fitting and persistence.

import { evalNow } from '../core/ablation.js';
import { oneCopyPerMemory } from './context-select.js';
import { compareEntryIdentity, compareScoresDesc } from '../core/compare.js';
import { isEmbeddingAvailable } from '../store/embeddings/local.js';
import { activeGoalsWithPolicies, type GoalRecallLogRow } from '../store/goals.js';
import { boostByGoals } from '../search/goal-boost.js';
import { graphExpandRecall } from '../graph/recall.js';
import { DEFAULT_GRAPH_STREAM_WEIGHT } from '../graph/stream.js';
import { Layer, type MemoryEntry } from '../core/memory.js';
import { multihopSearch } from '../search/multihop.js';
import type { PhysicsConfig } from '../core/physics-config.js';
import { passesCliRecallScopeFilter } from '../store/recall-scope.js';
import type { RerankerFn } from '../rerankers/types.js';
import { currentEntries } from '../search/as-of.js';
import { STRENGTH_RANK_FLOOR, STRENGTH_RANK_SPAN } from '../search/boosts.js';
import { hybridSearch } from '../search/hybrid.js';
import { physicsSearch } from '../search/physics-search.js';
import type { RerankStep, ResultCost, SearchResult } from '../core/search-types.js';
import { searchBothHybrid } from '../sharing/search-both.js';
import { loadRecallSearchEntries, recallScopeFilter } from '../store/search-rows.js';
import { textOverlap, tokenize as tokenizeQuery } from '../util/tokenize.js';

/** Stores rankRecall reads and where it sends operator notes. */
export interface RankRecallCtx {
  hippoRoot: string;
  /** A second store searched beside `hippoRoot`; leave undefined when there is none. */
  globalRoot?: string;
  tenantId: string;
  /** Receives each operator note when the pipeline reaches it, so it interleaves with other stderr in order. */
  note?: (line: string) => void;
}

/** Search-engine choice and tuning. */
export interface RecallSearchOpts {
  usePhysics: boolean;
  physicsConfig: PhysicsConfig;
  multihop: boolean;
  /** Graph-stream rrf fusion over the local store; hop and seed counts fall back to the engine defaults. */
  graphStream?: RecallGraphStream;
  mmr: boolean;
  mmrLambda: number;
  localBump: number;
  minResults?: number;
  /** Score breakdowns for `hippo explain`; explain's physics call also leaves out minResults and includeSuperseded. */
  explain: boolean;
}

/** `--graph-hops` and `--graph-seeds`. */
export interface RecallGraphStream { hops?: number; seeds?: number }

/** `--hops` and `--max-neighbors`. */
export interface RecallGraphHops { hops: number; maxNeighbors: number }

/** A reranker from the registry and how many head rows it sees. */
export interface RecallReranker { fn: RerankerFn; topK: number }

/** A stage rankRecall can stop before, in pipeline order. */
export type RankStage = 'expand' | 'rerank' | 'salience' | 'outcome' | 'layer';

/** Everything that shapes one ranking, already parsed and validated. */
export interface RankRecallOpts {
  query: string;
  /** Tokens the engines may spend, priced by `cost`. */
  budget: number;
  /** Price of one result, usually the tokens its printed line takes. */
  cost: ResultCost;
  limit: number;
  /** Record a rerank trace step for each score change. */
  why?: boolean;
  includeSuperseded: boolean;
  asOf?: string;
  /** `--scope`: unlocks that envelope scope on top of the default-admitted set. */
  explicitScope: string | null;
  /** Scope used for boosting only, never for filtering. */
  activeScope: string | null;
  search: RecallSearchOpts;
  graphHops?: RecallGraphHops;
  evcAdaptive?: boolean;
  filterConflicts?: boolean;
  valueAware?: boolean;
  rerankUtility?: boolean;
  reranker?: RecallReranker;
  /** Explicit goal tag; when set, the session goal stack is skipped. */
  goalTag?: string;
  /** Session whose active goals boost matching rows. */
  sessionId?: string;
  salienceThreshold?: number;
  outcome?: string;
  layer?: string;
  /** The caller rejected a flag this stage reads; ranking stops before it so the notes and goal-log rows
   *  produced up to there match the CLI's error path. */
  haltBefore?: RankStage;
}

/** Ranked results and what the caller needs to report and persist them. */
export interface RankRecallResult {
  results: SearchResult[];
  /** The candidate pools after the scope and bi-temporal filters. */
  localEntries: MemoryEntry[];
  globalEntries: MemoryEntry[];
  /** Candidates loaded, before any filter. */
  totalCandidates: number;
  /** Rows dropped by a named filter (scope, bi-temporal, conflicts, outcome, layer). */
  droppedPreRank: number;
  /** Rows graph expansion surfaced that the lexical pool never held. */
  graphAdded: number;
  /** goal_recall_log rows the session goal boost earned; the caller writes them. */
  goalRecallLog: GoalRecallLogRow[];
  /** True when ranking stopped at `haltBefore`. */
  halted: boolean;
}

interface RecallPool {
  local: MemoryEntry[];
  global: MemoryEntry[];
  total: number;
  dropped: number;
}

interface RankState {
  results: SearchResult[];
  droppedPreRank: number;
  graphAdded: number;
  goalRecallLog: GoalRecallLogRow[];
}

/** Ranks memories for a query as `hippo recall` does, through the `limit` slice. Reads stores, embeddings and
 *  physics state; writes nothing and prints nothing (notes go to `ctx.note`). The caller supplies the cost
 *  function and reranker in `opts`, and persists the returned goal-log rows. */
export async function rankRecall(ctx: RankRecallCtx, opts: RankRecallOpts): Promise<RankRecallResult> {
  const pool = loadRecallPool(ctx, opts);
  const state: RankState = { results: [], droppedPreRank: pool.dropped, graphAdded: 0, goalRecallLog: [] };
  const done = (halted: boolean): RankRecallResult => ({
    results: state.results,
    localEntries: pool.local,
    globalEntries: pool.global,
    totalCandidates: pool.total,
    droppedPreRank: state.droppedPreRank,
    graphAdded: state.graphAdded,
    goalRecallLog: state.goalRecallLog,
    halted,
  });

  state.results = await searchPool(ctx, opts, pool);
  if (opts.haltBefore === 'expand') return done(true);
  if (opts.graphHops) expandGraph(ctx, opts, opts.graphHops, state);
  applyPfcRerankers(opts, state);
  if (opts.haltBefore === 'rerank') return done(true);
  if (opts.reranker) state.results = await applyReranker(opts, opts.reranker, state.results);
  applyGoalBoosts(ctx, opts, state);
  if (opts.haltBefore === 'salience') return done(true);
  if (opts.salienceThreshold !== undefined) state.results = applySalience(opts, opts.salienceThreshold, state.results);
  if (opts.haltBefore === 'outcome') return done(true);
  if (opts.outcome) dropUnless(state, (r) => r.entry.layer !== Layer.Trace || r.entry.trace_outcome === opts.outcome);
  if (opts.haltBefore === 'layer') return done(true);
  if (opts.layer) dropUnless(state, (r) => r.entry.layer === opts.layer);
  if (opts.limit < state.results.length) state.results = state.results.slice(0, opts.limit);
  return done(false);
}

function loadRecallPool(ctx: RankRecallCtx, opts: RankRecallOpts): RecallPool {
  // An explicit --scope unlocks that envelope scope; the regex-only `<source>:private:*` deny is the JS half below.
  const requested = opts.explicitScope || undefined;
  const loadSuperseded = opts.includeSuperseded || Boolean(opts.asOf);
  let local = loadRecallSearchEntries(ctx.hippoRoot, opts.query, undefined, ctx.tenantId, requested, 'additive', loadSuperseded);
  let global = ctx.globalRoot
    ? loadRecallSearchEntries(ctx.globalRoot, opts.query, undefined, ctx.tenantId, requested, 'additive', loadSuperseded)
    : [];
  // SQL-excluded rows are pre-candidate, so the total is taken before the JS filters, which normally drop nothing.
  const total = local.length + global.length;
  const passes = (e: MemoryEntry): boolean => passesCliRecallScopeFilter(e.scope ?? null, requested);
  local = local.filter(passes);
  global = global.filter(passes);
  const currentness = { asOf: opts.asOf, includeSuperseded: opts.includeSuperseded };
  local = currentEntries(local, currentness);
  global = currentEntries(global, currentness);
  return { local, global, total, dropped: total - (local.length + global.length) };
}

async function searchPool(ctx: RankRecallCtx, opts: RankRecallOpts, pool: RecallPool): Promise<SearchResult[]> {
  const { query, budget, cost, includeSuperseded, asOf, activeScope: scope, search } = opts;
  const { mmr, mmrLambda, minResults, explain } = search;
  const globalRoot = pool.global.length > 0 ? ctx.globalRoot : undefined;
  if (search.graphStream) {
    // Without embeddings hybridSearch falls back to BM25-only and the stream is inert; say so rather than no-op.
    if (!isEmbeddingAvailable()) {
      ctx.note?.('[note] --graph-stream needs embeddings (rrf fusion); none available, so the graph stream is inert. Run `hippo embed` first.');
    }
    if (globalRoot) ctx.note?.('[note] --graph-stream searches the local store only; global graph fusion is a follow-up.');
    // With seedCount or fewer candidates every one is a seed and the stream degrades to the 2-list fusion.
    return hybridSearch(query, pool.local, {
      budget, cost, hippoRoot: ctx.hippoRoot, mmr, mmrLambda, minResults, scope, includeSuperseded, asOf,
      scoring: 'rrf',
      graphStream: { weight: DEFAULT_GRAPH_STREAM_WEIGHT, tenantId: ctx.tenantId, hops: search.graphStream.hops, seedCount: search.graphStream.seeds },
    });
  }
  if (search.multihop) {
    // Unlike searchBothHybrid below, multihop ranks one pooled list, so a shared memory's two copies both compete.
    const allEntries = oneCopyPerMemory(pool.local, pool.global, evalNow()).flat();
    return multihopSearch(query, allEntries, { budget, cost, hippoRoot: ctx.hippoRoot, minResults, includeSuperseded, asOf });
  }
  const requested = opts.explicitScope || undefined;
  const vectorCandidates = {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(requested, 'additive'),
    includeSuperseded: includeSuperseded || Boolean(asOf),
    admit: (e: MemoryEntry) => passesCliRecallScopeFilter(e.scope ?? null, requested),
  };
  if (search.usePhysics && !globalRoot) {
    // Explain leaves minResults and includeSuperseded out to hold its output steady; asOf must reach physics or later rows leak.
    const temporal = explain ? { asOf } : { minResults, includeSuperseded, asOf };
    return physicsSearch(query, pool.local, { budget, cost, hippoRoot: ctx.hippoRoot, physicsConfig: search.physicsConfig, scope, explain, vectorCandidates, ...temporal });
  }
  if (globalRoot) {
    // searchBothHybrid reloads candidates itself, so the scope rule is passed in rather than inherited from the pool.
    return searchBothHybrid(query, ctx.hippoRoot, globalRoot, {
      budget, cost, explain, mmr, mmrLambda, localBump: search.localBump, minResults, scope, tenantId: ctx.tenantId,
      includeSuperseded, asOf,
      recallScope: opts.explicitScope ? { requested: opts.explicitScope, additive: true } : {},
    });
  }
  return hybridSearch(query, pool.local, { budget, cost, hippoRoot: ctx.hippoRoot, explain, mmr, mmrLambda, minResults, scope, includeSuperseded, asOf, vectorCandidates });
}

/** Adds memories reached by walking the entity graph out from the lexical seeds. */
function expandGraph(ctx: RankRecallCtx, opts: RankRecallOpts, graph: RecallGraphHops, state: RankState): void {
  if (graph.hops <= 0) return;
  // Expansion both adds neighbours and evicts weak base rows, so compare id sets: a net count would hide both.
  const beforeGraphIds = new Set(state.results.map((r) => r.entry.id));
  state.results = graphExpandRecall(state.results, {
    hops: graph.hops,
    maxNeighbors: graph.maxNeighbors,
    hippoRoot: ctx.hippoRoot,
    globalRoot: ctx.globalRoot !== ctx.hippoRoot ? ctx.globalRoot : undefined,
    tenantId: ctx.tenantId,
    includeSuperseded: opts.includeSuperseded,
    asOf: opts.asOf,
    budget: opts.budget,
    cost: opts.cost,
    minResults: opts.search.minResults ?? 1,
    recallScope: opts.explicitScope ? { requested: opts.explicitScope, additive: true } : {},
  });
  for (const r of state.results) {
    if (!beforeGraphIds.has(r.entry.id)) state.graphAdded++;
  }
}

/** Appends one rerank step to a re-scored row when `why` is on. */
function traced<R extends SearchResult>(opts: RankRecallOpts, prev: SearchResult, next: R, step: RerankStep): R {
  if (opts.why) next.rerankTrace = [...(prev.rerankTrace ?? []), step];
  return next;
}

/** Re-sort after a score change. Plain and stable on purpose: ties keep the prior rank, not a content order. */
function byScore(results: SearchResult[]): SearchResult[] {
  return results.sort((a, b) => compareScoresDesc(a.score, b.score));
}

function applyPfcRerankers(opts: RankRecallOpts, state: RankState): void {
  if (opts.evcAdaptive && state.results.length >= 2) state.results = evcAdaptive(opts.query, state.results);
  if (opts.filterConflicts) {
    dropUnless(state, (r) => !r.entry.superseded_by);
    // Recorded conflicts only: a lexical-overlap gate once wrecked benchmark recall. Down-rank, never delete.
    const presentIds = new Set(state.results.map((r) => r.entry.id));
    state.results = byScore(state.results.map((r) => {
      const hasPeerInResults = (r.entry.conflicts_with || []).some((peerId) => presentIds.has(peerId));
      if (!hasPeerInResults) return r;
      const next = { ...r, score: r.score * CONFLICT_PEER_MULTIPLIER };
      return traced(opts, r, next, { stage: 'interference', multiplier: CONFLICT_PEER_MULTIPLIER, scoreBefore: r.score, scoreAfter: next.score });
    }));
  }
  if (opts.valueAware && state.results.length >= 1) {
    // Wider clamp than the always-on outcome boost, so outcome history can decide the order.
    state.results = byScore(state.results.map((r) => {
      const pos = r.entry.outcome_positive ?? 0;
      const neg = r.entry.outcome_negative ?? 0;
      if (pos === 0 && neg === 0) return r;
      const valueMult = Math.max(VALUE_MULT_MIN, Math.min(VALUE_MULT_MAX, 1 + VALUE_MULT_SLOPE * Math.tanh(pos - neg)));
      const next = { ...r, score: r.score * valueMult };
      return traced(opts, r, next, { stage: 'value', multiplier: valueMult, scoreBefore: r.score, scoreAfter: next.score });
    }));
  }
  if (opts.rerankUtility) {
    // utility = score * (0.5 + 0.5 * strength) * (1 - min(0.3, tokens / 10000)); long evidence-rich rows pay for length.
    state.results = byScore(state.results.map((r) => {
      const strength = typeof r.entry.strength === 'number' ? r.entry.strength : 1.0;
      const utilityMult = (STRENGTH_RANK_FLOOR + STRENGTH_RANK_SPAN * strength) * (1 - Math.min(UTILITY_LENGTH_PENALTY_CAP, (r.tokens || 0) / UTILITY_LENGTH_TOKENS));
      const utility = r.score * utilityMult;
      return traced(opts, r, { ...r, score: utility }, { stage: 'utility', multiplier: utilityMult, scoreBefore: r.score, scoreAfter: utility });
    }));
  }
}

// A recorded conflict peer in the same result list is cut to this share of its score.
const CONFLICT_PEER_MULTIPLIER = 0.3;
// The value-aware clamp is wider than the always-on outcome nudge, so outcome history can decide the order.
const VALUE_MULT_SLOPE = 0.3;
const VALUE_MULT_MIN = 0.7;
const VALUE_MULT_MAX = 1.3;
const UTILITY_LENGTH_PENALTY_CAP = 0.3;
const UTILITY_LENGTH_TOKENS = 10000;
// evcAdaptive acts when the top hits overlap this much; it keeps rows near the best score or covering the query.
const NEAR_DUPLICATE_OVERLAP_MIN = 0.4;
const SCORE_FLOOR_FRACTION = 0.5;
const QUERY_COVERAGE_MIN = 0.6;
const GOAL_TAG_BOOST = 1.5;
const SALIENCE_MIN_MULTIPLIER = 0.5;

/** When the top hits are near-duplicates (same topic, different facts), surface the newest on-topic row first. */
function evcAdaptive(query: string, results: SearchResult[]): SearchResult[] {
  const slice = results.slice(0, Math.min(3, results.length));
  let pairs = 0;
  let overlapSum = 0;
  for (let i = 0; i < slice.length; i++) {
    for (let j = i + 1; j < slice.length; j++) {
      overlapSum += textOverlap(slice[i].entry.content, slice[j].entry.content);
      pairs++;
    }
  }
  if ((pairs > 0 ? overlapSum / pairs : 0) < NEAR_DUPLICATE_OVERLAP_MIN) return results;
  const poolSize = Math.min(results.length, Math.max(slice.length * 3, 9));
  const pool = results.slice(0, poolSize);
  const scoreFloor = pool.reduce((m, r) => Math.max(m, r.score), 0) * SCORE_FLOOR_FRACTION;
  // Query coverage catches the differently phrased update a score floor alone would miss.
  const queryTokens = new Set(tokenizeQuery(query));
  const onTopic: SearchResult[] = [];
  const offTopic: SearchResult[] = [];
  for (const r of pool) {
    let hits = 0;
    if (queryTokens.size > 0) {
      const candTokens = new Set(tokenizeQuery(r.entry.content));
      for (const t of queryTokens) if (candTokens.has(t)) hits++;
    }
    const queryCoverage = queryTokens.size > 0 ? hits / queryTokens.size : 0;
    (r.score >= scoreFloor || queryCoverage >= QUERY_COVERAGE_MIN ? onTopic : offTopic).push(r);
  }
  // Recency is the primary key; identity only breaks exact-timestamp ties.
  onTopic.sort((a, b) => {
    const ta = new Date(a.entry.created).getTime();
    const tb = new Date(b.entry.created).getTime();
    return tb !== ta ? tb - ta : compareEntryIdentity(a.entry, b.entry);
  });
  return [...onTopic, ...offTopic, ...results.slice(poolSize)];
}

async function applyReranker(opts: RankRecallOpts, reranker: RecallReranker, results: SearchResult[]): Promise<SearchResult[]> {
  const { fn, topK } = reranker;
  const rerankInput = results.slice(0, topK).map((r, i) => ({ ...r, preRerankRank: i + 1 }));
  const reranked = await fn(opts.query, rerankInput, { topK });
  // The reranker's score becomes `score` so later stages that sort by score keep its order.
  const withPostRank = reranked.map((r, i) =>
    traced(opts, r, { ...r, score: r.rerankScore, postRerankRank: i + 1 }, { stage: 'reranker', scoreBefore: r.score, scoreAfter: r.rerankScore }));
  return [...withPostRank, ...results.slice(topK)];
}

function applyGoalBoosts(ctx: RankRecallCtx, opts: RankRecallOpts, state: RankState): void {
  const goalTag = opts.goalTag ?? '';
  if (goalTag) {
    // Its own trace stage: `goal` is the explicit flag, `goal-boost` the session stack it replaces.
    state.results = byScore(state.results.map((r) => {
      if (!r.entry.tags?.includes(goalTag)) return r;
      const boosted = { ...r, score: r.score * GOAL_TAG_BOOST };
      return traced(opts, r, boosted, { stage: 'goal', multiplier: GOAL_TAG_BOOST, scoreBefore: r.score, scoreAfter: r.score * GOAL_TAG_BOOST, note: `--goal ${goalTag}` });
    }));
    return;
  }
  if (!opts.sessionId) return;
  // The helper re-spreads rows, so its steps come back in a map keyed by entry id.
  const goalBoostTrace = opts.why ? new Map<string, RerankStep>() : undefined;
  const session = { sessionId: opts.sessionId, tenantId: ctx.tenantId };
  // The log may name global rows; the store drops those when it writes, as it does for api.recall.
  const boost = boostByGoals(state.results, activeGoalsWithPolicies(ctx.hippoRoot, session), { ...session, limit: opts.limit, trace: goalBoostTrace });
  state.results = boost.results;
  state.goalRecallLog = boost.log;
  if (goalBoostTrace && goalBoostTrace.size > 0) {
    state.results = state.results.map((r) => {
      const step = goalBoostTrace.get(r.entry.id);
      return step ? { ...r, rerankTrace: [...(r.rerankTrace ?? []), step] } : r;
    });
  }
}

/** Soft-demotes rarely recalled rows: score *= max(0.5, retrieval_count / T); never drops one. */
function applySalience(opts: RankRecallOpts, threshold: number, results: SearchResult[]): SearchResult[] {
  return byScore(results.map((r) => {
    const count = r.entry.retrieval_count ?? 0;
    if (count >= threshold) return r;
    const mult = Math.max(SALIENCE_MIN_MULTIPLIER, count / threshold);
    const next = { ...r, score: r.score * mult };
    return traced(opts, r, next, { stage: 'retrieval-count-downweight', multiplier: mult, scoreBefore: r.score, scoreAfter: next.score });
  }));
}

function dropUnless(state: RankState, keep: (r: SearchResult) => boolean): void {
  const before = state.results.length;
  state.results = state.results.filter(keep);
  state.droppedPreRank += before - state.results.length;
}
