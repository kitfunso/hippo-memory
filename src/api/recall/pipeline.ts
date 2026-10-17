// Ranking core shared by `hippo recall` and `hippo explain`: load, search, expand, re-rank and filter, with no
// writes and no direct output. Callers own flag parsing, printing, budget fitting and persistence.

import { evalNow } from '../../core/ablation.js';
import { oneCopyPerMemory } from '../context-select.js';
import { compareEntryIdentity, compareScoresDesc } from '../../core/compare.js';
import { isEmbeddingAvailable } from '../../embeddings/local.js';
import type { GoalRecallLogRow } from '../../store/goals.js';
import { boostByGoals } from '../../search/goal-boost.js';
import { graphExpandRecall } from '../../graph/recall.js';
import { DEFAULT_GRAPH_STREAM_WEIGHT } from '../../graph/stream.js';
import { Layer, type MemoryEntry } from '../../core/memory.js';
import { multihopSearch } from '../../search/multihop.js';
import type { PhysicsConfig } from '../../core/physics-config.js';
import { passesCliRecallScopeFilter } from '../../core/recall-scope.js';
import type { RerankerFn } from '../../rerankers/types.js';
import { currentEntries } from '../../search/as-of.js';
import { STRENGTH_RANK_FLOOR, STRENGTH_RANK_SPAN } from '../../search/boosts.js';
import { hybridSearch, vectorSourceOf } from '../../search/hybrid.js';
import { applyReranker } from '../../search/rerank.js';
import { searchByEngine } from '../../search/engine.js';
import type { HippoConfig } from '../../core/config.js';
import {
  CONFLICT_PEER_MULTIPLIER,
  SALIENCE_MIN_MULTIPLIER,
  UTILITY_LENGTH_PENALTY_CAP,
  UTILITY_LENGTH_TOKENS,
  VALUE_MULT_MAX,
  VALUE_MULT_MIN,
  VALUE_MULT_SLOPE,
  type RerankStep,
  type ResultCost,
  type SearchResult,
} from '../../core/search-types.js';
import { rankBothStores } from '../../sharing/search-both.js';
import { recallScopeFilter } from '../../store/search-rows.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../../store/rows.js';
import type { HippoStore } from '../../store/index.js';
import { isJsonNumber } from '../../util/json.js';
import { currentSignal } from '../../util/request-scope.js';
import { textOverlap, tokenize as tokenizeQuery } from '../../util/tokenize.js';
import type { RecallBoostOptions, RecallWindowOptions } from './types.js';

/** A store rankRecall reads, with the config that names its embedding model. */
export interface RankSource {
  readonly store: HippoStore;
  readonly config: HippoConfig;
}

/** Stores rankRecall reads and where it sends operator notes. */
export interface RankRecallCtx extends RankSource {
  /** A second store searched beside `store`; leave undefined when there is none. Passing `store` itself reads it
   * twice but walks its graph once. */
  global?: RankSource;
  tenantId: string;
  /** Receives each operator note when the pipeline reaches it, so it interleaves with other stderr in order. */
  note?: (line: string) => void;
}

/** Search-engine choice and tuning. */
export interface RecallSearchOptions {
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
export interface RankRecallOptions {
  query: string;
  /** Tokens the engines may spend, priced by `cost`. */
  budget: number;
  /** Price of one result, usually the tokens its printed line takes. */
  cost: ResultCost;
  window: Required<Pick<RecallWindowOptions, 'limit'>>;
  /** Record a rerank trace step for each score change. */
  why?: boolean;
  includeSuperseded: boolean;
  asOf?: string;
  /** `--scope`: unlocks that envelope scope on top of the default-admitted set. */
  explicitScope: string | null;
  /** Scope used for boosting only, never for filtering. */
  activeScope: string | null;
  search: RecallSearchOptions;
  graphHops?: RecallGraphHops;
  evcAdaptive?: boolean;
  filterConflicts?: boolean;
  valueAware?: boolean;
  rerankUtility?: boolean;
  reranker?: RecallReranker;
  boost?: RecallBoostOptions;
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

/**
 * Ranks memories for a query as `hippo recall` does, through the `limit` slice. Reads stores, embeddings and physics
 * state; writes and prints nothing
 * (notes go to `ctx.note`). The caller supplies the cost function and reranker in `opts` and persists the returned
 * goal-log rows.
 */
export async function rankRecall(ctx: RankRecallCtx, opts: RankRecallOptions): Promise<RankRecallResult> {
  const pool = await loadRecallPool(ctx, opts);
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
  // A request past its deadline during the search has no caller left for the later stages.
  currentSignal()?.throwIfAborted();
  if (opts.haltBefore === 'expand') return done(true);
  if (opts.graphHops) await expandGraph(ctx, opts, opts.graphHops, state);
  applyPfcRerankers(opts, state);
  if (opts.haltBefore === 'rerank') return done(true);
  if (opts.reranker) state.results = await applyRecallReranker(opts, opts.reranker, state.results);
  await applyGoalBoosts(ctx, opts, state);
  if (opts.haltBefore === 'salience') return done(true);
  if (opts.salienceThreshold !== undefined) state.results = applySalience(opts, opts.salienceThreshold, state.results);
  if (opts.haltBefore === 'outcome') return done(true);
  if (opts.outcome) dropUnless(state, (r) => r.entry.layer !== Layer.Trace || r.entry.trace_outcome === opts.outcome);
  if (opts.haltBefore === 'layer') return done(true);
  if (opts.layer) dropUnless(state, (r) => r.entry.layer === opts.layer);
  const { limit } = opts.window;
  if (limit < state.results.length) state.results = state.results.slice(0, limit);
  return done(false);
}

async function loadRecallPool(ctx: RankRecallCtx, opts: RankRecallOptions): Promise<RecallPool> {
  // An explicit --scope unlocks that envelope scope; the regex-only `<source>:private:*` deny is the JS half below.
  const requested = opts.explicitScope || undefined;
  const loadSuperseded = opts.includeSuperseded || Boolean(opts.asOf);
  const load = {
    limit: DEFAULT_SEARCH_CANDIDATE_LIMIT,
    tenantId: ctx.tenantId,
    requestedScope: requested,
    explicitScopeMode: 'additive',
    includeSuperseded: loadSuperseded,
    ownScope: undefined,
  } as const;
  let local = await ctx.store.searchRecallEntries(opts.query, load);
  let global = ctx.global ? await ctx.global.store.searchRecallEntries(opts.query, load) : [];
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

function graphStreamSearch(
  ctx: RankRecallCtx,
  opts: RankRecallOptions,
  graphStream: NonNullable<RankRecallOptions['search']['graphStream']>,
  pool: RecallPool,
): Promise<SearchResult[]> {
  const { query, budget, cost, includeSuperseded, asOf, activeScope: scope, search } = opts;
  const { mmr, mmrLambda, minResults } = search;
  // Without embeddings hybridSearch falls back to BM25-only and the stream is inert; say so rather than no-op.
  if (!isEmbeddingAvailable()) {
    ctx.note?.(
      '[note] --graph-stream needs embeddings (rrf fusion); none available, so the graph stream is inert. Run ' +
      '`hippo embed` first.',
    );
  }
  if (ctx.global && pool.global.length > 0) {
    ctx.note?.('[note] --graph-stream searches the local store only; global graph fusion is a follow-up.');
  }
  // With seedCount or fewer candidates every one is a seed and the stream degrades to the 2-list fusion.
  return hybridSearch(query, pool.local, {
    budget, cost, source: vectorSourceOf(ctx), mmr, mmrLambda, minResults, scope, includeSuperseded, asOf,
    scoring: 'rrf',
    graphStream: {
      weight: DEFAULT_GRAPH_STREAM_WEIGHT,
      tenantId: ctx.tenantId,
      hops: graphStream.hops,
      seedCount: graphStream.seeds,
    },
  });
}

function multihopPoolSearch(opts: RankRecallOptions, pool: RecallPool): SearchResult[] {
  const { query, budget, cost, includeSuperseded, asOf, search } = opts;
  const { minResults } = search;
  // Unlike rankBothStores below, multihop ranks one pooled list, so a shared memory's two copies both compete.
  const allEntries = oneCopyPerMemory(pool.local, pool.global, evalNow()).flat();
  const globalIds = new Set(pool.global.map((e) => e.id));
  const localIds = new Set(pool.local.map((e) => e.id));
  const fromGlobal = (id: string): boolean => globalIds.has(id) && !localIds.has(id);
  const results = multihopSearch(query, allEntries, {
    budget,
    cost: cost && ((r) => cost({ ...r, isGlobal: fromGlobal(r.entry.id) })),
    minResults,
    includeSuperseded,
    asOf,
  });
  return results.map((r) => ({ ...r, isGlobal: fromGlobal(r.entry.id) }));
}

function poolVectorCandidates(ctx: RankRecallCtx, opts: RankRecallOptions) {
  const requested = opts.explicitScope || undefined;
  return {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(requested, 'additive'),
    includeSuperseded: opts.includeSuperseded || Boolean(opts.asOf),
    admit: (e: MemoryEntry) => passesCliRecallScopeFilter(e.scope ?? null, requested),
  };
}

async function searchPool(ctx: RankRecallCtx, opts: RankRecallOptions, pool: RecallPool): Promise<SearchResult[]> {
  const { query, budget, cost, includeSuperseded, asOf, activeScope: scope, search } = opts;
  const { mmr, mmrLambda, minResults, explain } = search;
  if (search.graphStream) return graphStreamSearch(ctx, opts, search.graphStream, pool);
  if (search.multihop) return multihopPoolSearch(opts, pool);
  const vectorCandidates = poolVectorCandidates(ctx, opts);
  if (ctx.global && pool.global.length > 0) {
    // The pool already holds searchBothHybrid's additive-scope load for each store, so rank it rather than read both
    // stores again.
    return rankBothStores(
      query,
      { local: vectorSourceOf(ctx), global: vectorSourceOf(ctx.global) },
      { local: pool.local, global: pool.global },
      vectorCandidates,
      {
        budget,
        cost,
        explain,
        mmr,
        mmrLambda,
        localBump: search.localBump,
        minResults,
        scope,
        tenantId: ctx.tenantId,
        includeSuperseded,
        asOf,
      },
    );
  }
  const physics = search.usePhysics ? search.physicsConfig : null;
  // Physics takes no MMR; explain drops minResults and includeSuperseded to hold its output steady; asOf must reach
  // physics or later rows leak.
  const tuning = !physics
    ? { mmr, mmrLambda, minResults, includeSuperseded, asOf }
    : explain
      ? { asOf }
      : { minResults, includeSuperseded, asOf };
  return searchByEngine(vectorSourceOf(ctx), query, pool.local, physics, {
    budget,
    cost,
    scope,
    explain,
    vectorCandidates,
    ...tuning,
  });
}

/** Adds memories reached by walking the entity graph out from the lexical seeds. */
async function expandGraph(
  ctx: RankRecallCtx, opts: RankRecallOptions, graph: RecallGraphHops, state: RankState,
): Promise<void> {
  if (graph.hops <= 0) return;
  // Expansion both adds neighbors and evicts weak base rows, so compare id sets: a net count would hide both.
  const beforeGraphIds = new Set(state.results.map((r) => r.entry.id));
  state.results = await graphExpandRecall(state.results, {
    hops: graph.hops,
    maxNeighbors: graph.maxNeighbors,
    store: ctx.store,
    global: ctx.global?.store,
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
function traced<R extends SearchResult>(opts: RankRecallOptions, prev: SearchResult, next: R, step: RerankStep): R {
  if (opts.why) next.rerankTrace = [...(prev.rerankTrace ?? []), step];
  return next;
}

/** Re-sort after a score change. Plain and stable on purpose: ties keep the prior rank, not a content order. */
function byScore(results: SearchResult[]): SearchResult[] {
  return results.sort((a, b) => compareScoresDesc(a.score, b.score));
}

function demoteConflictPeers(opts: RankRecallOptions, state: RankState): void {
  // Recorded conflicts only: a lexical-overlap gate once wrecked benchmark recall. Down-rank, never delete.
  const presentIds = new Set(state.results.map((r) => r.entry.id));
  state.results = byScore(
    state.results.map((r) => {
      const hasPeerInResults = (r.entry.conflicts_with || []).some((peerId) => presentIds.has(peerId));
      if (!hasPeerInResults) return r;
      const next = { ...r, score: r.score * CONFLICT_PEER_MULTIPLIER };
      return traced(opts, r, next, {
        stage: 'interference',
        multiplier: CONFLICT_PEER_MULTIPLIER,
        scoreBefore: r.score,
        scoreAfter: next.score,
      });
    }),
  );
}

function applyValueAware(opts: RankRecallOptions, state: RankState): void {
  // Wider clamp than the always-on outcome boost, so outcome history can decide the order.
  state.results = byScore(
    state.results.map((r) => {
      const pos = r.entry.outcome_positive ?? 0;
      const neg = r.entry.outcome_negative ?? 0;
      if (pos === 0 && neg === 0) return r;
      const valueMult = Math.max(
        VALUE_MULT_MIN,
        Math.min(VALUE_MULT_MAX, 1 + VALUE_MULT_SLOPE * Math.tanh(pos - neg)),
      );
      const next = { ...r, score: r.score * valueMult };
      return traced(opts, r, next, {
        stage: 'value',
        multiplier: valueMult,
        scoreBefore: r.score,
        scoreAfter: next.score,
      });
    }),
  );
}

function applyUtilityRank(opts: RankRecallOptions, state: RankState): void {
  state.results = byScore(
    state.results.map((r) => {
      const strength = isJsonNumber(r.entry.strength) ? r.entry.strength : 1.0;
      const utilityMult =
        (STRENGTH_RANK_FLOOR + STRENGTH_RANK_SPAN * strength) *
        (1 - Math.min(UTILITY_LENGTH_PENALTY_CAP, (r.tokens || 0) / UTILITY_LENGTH_TOKENS));
      const utility = r.score * utilityMult;
      return traced(
        opts,
        r,
        { ...r, score: utility },
        { stage: 'utility', multiplier: utilityMult, scoreBefore: r.score, scoreAfter: utility },
      );
    }),
  );
}

function applyPfcRerankers(opts: RankRecallOptions, state: RankState): void {
  if (opts.evcAdaptive && state.results.length >= 2) state.results = evcAdaptive(opts.query, state.results);
  if (opts.filterConflicts) {
    dropUnless(state, (r) => !r.entry.superseded_by);
    demoteConflictPeers(opts, state);
  }
  if (opts.valueAware && state.results.length >= 1) applyValueAware(opts, state);
  if (opts.rerankUtility) applyUtilityRank(opts, state);
}

// evcAdaptive acts when the top hits overlap this much; it keeps rows near the best score or covering the query.
const NEAR_DUPLICATE_OVERLAP_MIN = 0.4;
const SCORE_FLOOR_FRACTION = 0.5;
const QUERY_COVERAGE_MIN = 0.6;
const GOAL_TAG_BOOST = 1.5;
// The near-duplicate check looks at this many top hits; the re-ordered pool is three times that, at least 9.
const NEAR_DUPLICATE_WINDOW = 3;
const NEAR_DUPLICATE_POOL_MIN = 9;

/** When the top hits are near-duplicates (same topic, different facts), surface the newest on-topic row first. */
function evcAdaptive(query: string, results: SearchResult[]): SearchResult[] {
  const slice = results.slice(0, Math.min(NEAR_DUPLICATE_WINDOW, results.length));
  let pairs = 0;
  let overlapSum = 0;
  for (let i = 0; i < slice.length; i++) {
    for (let j = i + 1; j < slice.length; j++) {
      overlapSum += textOverlap(slice[i].entry.content, slice[j].entry.content);
      pairs++;
    }
  }
  if ((pairs > 0 ? overlapSum / pairs : 0) < NEAR_DUPLICATE_OVERLAP_MIN) return results;
  const poolSize = Math.min(results.length, Math.max(slice.length * NEAR_DUPLICATE_WINDOW, NEAR_DUPLICATE_POOL_MIN));
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

function applyRecallReranker(
  opts: RankRecallOptions,
  reranker: RecallReranker,
  results: SearchResult[],
): Promise<SearchResult[]> {
  // The reranker's score becomes `score` so later stages that sort by score keep its order.
  return applyReranker(opts.query, results, reranker.fn, { topK: reranker.topK }, (r) =>
    traced(
      opts,
      r,
      { ...r, score: r.rerankScore },
      { stage: 'reranker', scoreBefore: r.score, scoreAfter: r.rerankScore },
    ),
  );
}

async function applyGoalBoosts(ctx: RankRecallCtx, opts: RankRecallOptions, state: RankState): Promise<void> {
  const { goalTag = '', sessionId } = opts.boost ?? {};
  if (goalTag) {
    // Its own trace stage: `goal` is the explicit flag, `goal-boost` the session stack it replaces.
    state.results = byScore(
      state.results.map((r) => {
        if (!r.entry.tags?.includes(goalTag)) return r;
        const boosted = { ...r, score: r.score * GOAL_TAG_BOOST };
        return traced(opts, r, boosted, {
          stage: 'goal',
          multiplier: GOAL_TAG_BOOST,
          scoreBefore: r.score,
          scoreAfter: r.score * GOAL_TAG_BOOST,
          note: `--goal ${goalTag}`,
        });
      }),
    );
    return;
  }
  if (!sessionId) return;
  // The helper re-spreads rows, so its steps come back in a map keyed by entry id.
  const goalBoostTrace = opts.why ? new Map<string, RerankStep>() : undefined;
  const session = { sessionId, tenantId: ctx.tenantId };
  // The log may name global rows; the store drops those when it writes, as it does for api.recall.
  const boost = boostByGoals(state.results, await ctx.store.activeGoals(session), {
    ...session,
    limit: opts.window.limit,
    trace: goalBoostTrace,
  });
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
function applySalience(opts: RankRecallOptions, threshold: number, results: SearchResult[]): SearchResult[] {
  return byScore(
    results.map((r) => {
      const count = r.entry.retrieval_count ?? 0;
      if (count >= threshold) return r;
      const mult = Math.max(SALIENCE_MIN_MULTIPLIER, count / threshold);
      const next = { ...r, score: r.score * mult };
      return traced(opts, r, next, {
        stage: 'retrieval-count-downweight',
        multiplier: mult,
        scoreBefore: r.score,
        scoreAfter: next.score,
      });
    }),
  );
}

function dropUnless(state: RankState, keep: (r: SearchResult) => boolean): void {
  const before = state.results.length;
  state.results = state.results.filter(keep);
  state.droppedPreRank += before - state.results.length;
}
