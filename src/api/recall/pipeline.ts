// Ranking core shared by `hippo recall` and `hippo explain`: load, search, expand, re-rank and filter, with no writes
// and no direct output. Callers own flag parsing, printing, budget fitting and persistence.

import { evalNow } from '../../base/memory/ablation.js';
import { oneCopyPerMemory } from '../context-select.js';
import { compareEntryIdentity, compareScoresDesc } from '../../base/rank/compare.js';
import { isEmbeddingAvailable } from '../../base/embeddings/local.js';
import { boostByGoals } from '../../domain/search/goal-boost.js';
import { graphExpandRecall } from '../../domain/graph/recall.js';
import { DEFAULT_GRAPH_STREAM_WEIGHT } from '../../domain/graph/stream.js';
import { Layer, strengthOptionsOf, type MemoryEntry } from '../../base/memory/memory.js';
import { multihopSearch } from '../../domain/search/multihop.js';
import type { PhysicsConfig } from '../../base/rank/physics-config.js';
import { passesCliRecallScopeFilter, recallScopeFilter } from '../../base/scope/recall-scope.js';
import type { RerankerFn } from '../../base/ports/reranker.js';
import { currentEntries } from '../../domain/search/as-of.js';
import { STRENGTH_RANK_FLOOR, STRENGTH_RANK_SPAN } from '../../domain/search/boosts.js';
import { hybridSearch, vectorSourceOf } from '../../domain/search/hybrid.js';
import { applyReranker } from '../../domain/search/rerank.js';
import { searchByEngine } from '../../domain/search/engine.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import {
  CONFLICT_PEER_MULTIPLIER,
  DEFAULT_SEARCH_CANDIDATE_LIMIT,
  SALIENCE_MIN_MULTIPLIER,
  UTILITY_LENGTH_PENALTY_CAP,
  UTILITY_LENGTH_TOKENS,
  VALUE_MULT_MAX,
  VALUE_MULT_MIN,
  VALUE_MULT_SLOPE,
  type RerankStep,
  type ResultCost,
  type SearchResult,
} from '../../base/rank/search-types.js';
import { rankBothStores } from '../../domain/sharing/search-both.js';
import type { HippoStore } from '../../store/port.js';
import { isJsonNumber } from '../../base/util/json.js';
import { currentSignal } from '../../base/util/request-scope.js';
import { textOverlap, tokenize as tokenizeQuery } from '../../base/util/tokenize.js';
import type { RecallBoostOptions, RecallWindowOptions } from './types.js';
import type { GoalRecallLogRow } from '../../store/port/recall-writes.js';

/** A store rankRecall reads, with the config that names its embedding model. */
export interface RankSource {
  readonly store: HippoStore;
  readonly config: HippoConfig;
  readonly onHippoDb?: boolean;
}

/** Stores rankRecall reads and where it sends operator notes. */
export interface RankRecallCtx extends RankSource {
  /** A second store searched beside `store`; leave undefined when there is none. Passing `store` itself reads it twice
   * but walks its graph once. */
  global?: RankSource;
  tenantId: string;
  /** Builds the provider that embeds the query for each store's vector arm. */
  embedderFor: EmbedderFor;
  /** The folder whose path segments boost a memory; absent, no path boost. */
  cwd?: string;
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
export interface RecallGraphStream {
  hops?: number;
  seeds?: number;
}

/** `--hops` and `--max-neighbors`. */
export interface RecallGraphHops {
  hops: number;
  maxNeighbors: number;
}

/** A reranker from the registry and how many head rows it sees. */
export interface RecallReranker {
  fn: RerankerFn;
  topK: number;
}

/** A stage rankRecall can stop before, in pipeline order. */
export type RankStage = 'expand' | 'rerank' | 'salience' | 'outcome' | 'layer';

/** The rows a ranking may return, and the scope its boosts favour. */
export interface RankRecallFilters {
  includeSuperseded: boolean;
  asOf?: string;
  /** `--scope`: unlocks that envelope scope on top of the default-admitted set. */
  explicitScope: string | null;
  /** Scope used for boosting only, never for filtering. */
  activeScope: string | null;
}

/** The stages after the search, each off until its flag sets it. */
export interface RankRecallStages {
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
  /** The caller rejected a flag this stage reads; ranking stops before it so the notes and goal-log rows produced up to
   *  there match the CLI's error path. */
  haltBefore?: RankStage;
}

/** Everything that shapes one ranking, already parsed and validated. */
export interface RankRecallOptions extends RankRecallFilters, RankRecallStages {
  query: string;
  /** Tokens the engines may spend, priced by `cost`. */
  budget: number;
  /** Price of one result, usually the tokens its printed line takes. */
  cost: ResultCost;
  window: Required<Pick<RecallWindowOptions, 'limit'>>;
  /** Record a rerank trace step for each score change. */
  why?: boolean;
  search: RecallSearchOptions;
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
 * state; writes and prints nothing (notes go to `ctx.note`). The caller supplies the cost function and reranker in
 * `opts` and persists the returned goal-log rows.
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
  for (const stage of RANK_STAGES) {
    if (opts.haltBefore === stage.name) return done(true);
    await stage.run(ctx, opts, state);
  }
  const { limit } = opts.window;
  if (limit < state.results.length) state.results = state.results.slice(0, limit);
  return done(false);
}

/** The stages after the search, in order; `haltBefore` stops the walk ahead of the stage it names. */
const RANK_STAGES: readonly {
  readonly name: RankStage;
  readonly run: (ctx: RankRecallCtx, opts: RankRecallOptions, state: RankState) => void | Promise<void>;
}[] = [
  {
    name: 'expand',
    run: async (ctx, opts, state) => {
      if (opts.graphHops) await expandGraph(ctx, opts, opts.graphHops, state);
      reorderResults(opts, state);
    },
  },
  {
    name: 'rerank',
    run: async (ctx, opts, state) => {
      if (opts.reranker) state.results = await applyRecallReranker(opts, opts.reranker, state.results, ctx.config);
      await applyGoalBoosts(ctx, opts, state);
    },
  },
  {
    name: 'salience',
    run: (_ctx, opts, state) => {
      if (opts.salienceThreshold !== undefined) {
        state.results = applySalience(opts, opts.salienceThreshold, state.results);
      }
    },
  },
  {
    name: 'outcome',
    run: (_ctx, opts, state) => {
      if (opts.outcome) {
        dropUnless(state, (r) => r.entry.layer !== Layer.Trace || r.entry.traceOutcome === opts.outcome);
      }
    },
  },
  {
    name: 'layer',
    run: (_ctx, opts, state) => {
      if (opts.layer) dropUnless(state, (r) => r.entry.layer === opts.layer);
    },
  },
];

interface PoolScope {
  /** An explicit --scope unlocks that envelope scope; the regex-only `<source>:private:*` deny is the JS half. */
  requested: string | undefined;
  /** An as-of read needs the rows a later write superseded. */
  loadSuperseded: boolean;
}

function poolScope(opts: RankRecallOptions): PoolScope {
  return { requested: opts.explicitScope || undefined, loadSuperseded: opts.includeSuperseded || Boolean(opts.asOf) };
}

async function loadRecallPool(ctx: RankRecallCtx, opts: RankRecallOptions): Promise<RecallPool> {
  const { requested, loadSuperseded } = poolScope(opts);
  const load = {
    limit: DEFAULT_SEARCH_CANDIDATE_LIMIT,
    tenantId: ctx.tenantId,
    requestedScope: requested,
    explicitScopeMode: 'additive',
    includeSuperseded: loadSuperseded,
    ownScope: undefined,
  } as const;
  // The two stores are independent, so their reads overlap; Promise.all keeps the local-then-global order.
  const reads = await Promise.all([
    ctx.store.searchRecallEntries(opts.query, load),
    ctx.global ? ctx.global.store.searchRecallEntries(opts.query, load) : Promise.resolve([]),
  ]);
  let [local, global] = reads;
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
    budget,
    cost,
    runtime: ctx.config.runtime,
    cwd: ctx.cwd,
    source: vectorSourceOf(ctx),
    mmr,
    mmrLambda,
    minResults,
    scope,
    includeSuperseded,
    asOf,
    scoring: 'rrf',
    graphStream: {
      weight: DEFAULT_GRAPH_STREAM_WEIGHT,
      tenantId: ctx.tenantId,
      hops: graphStream.hops,
      seedCount: graphStream.seeds,
    },
  });
}

function multihopPoolSearch(ctx: RankRecallCtx, opts: RankRecallOptions, pool: RecallPool): SearchResult[] {
  const { query, budget, cost, includeSuperseded, asOf, search } = opts;
  const { minResults } = search;
  // Unlike rankBothStores below, multihop ranks one pooled list, so a shared memory's two copies both compete.
  const allEntries = oneCopyPerMemory(pool.local, pool.global, evalNow(), strengthOptionsOf(ctx.config.runtime)).flat();
  const globalIds = new Set(pool.global.map((e) => e.id));
  const localIds = new Set(pool.local.map((e) => e.id));
  const fromGlobal = (id: string): boolean => globalIds.has(id) && !localIds.has(id);
  const results = multihopSearch(query, allEntries, {
    budget,
    cost: cost && ((r) => cost({ ...r, isGlobal: fromGlobal(r.entry.id) })),
    minResults,
    includeSuperseded,
    asOf,
    scope: ctx.config.runtime?.activeScope ?? null,
    runtime: ctx.config.runtime,
    cwd: ctx.cwd,
  });
  return results.map((r) => ({ ...r, isGlobal: fromGlobal(r.entry.id) }));
}

function poolVectorCandidates(ctx: RankRecallCtx, opts: RankRecallOptions) {
  const { requested, loadSuperseded } = poolScope(opts);
  return {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(requested, 'additive'),
    includeSuperseded: loadSuperseded,
    admit: (e: MemoryEntry) => passesCliRecallScopeFilter(e.scope ?? null, requested),
  };
}

async function searchPool(ctx: RankRecallCtx, opts: RankRecallOptions, pool: RecallPool): Promise<SearchResult[]> {
  const { query, budget, cost, includeSuperseded, asOf, activeScope: scope, search } = opts;
  const { mmr, mmrLambda, minResults, explain } = search;
  if (search.graphStream) return graphStreamSearch(ctx, opts, search.graphStream, pool);
  if (search.multihop) return multihopPoolSearch(ctx, opts, pool);
  const vectorCandidates = poolVectorCandidates(ctx, opts);
  if (ctx.global && pool.global.length > 0) {
    // The pool already holds searchBothHybrid's additive-scope load for each store, so rank it rather than read both
    // stores again.
    return rankBothStores(
      query,
      { local: vectorSourceOf(ctx), global: vectorSourceOf({ ...ctx.global, embedderFor: ctx.embedderFor }) },
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
        runtime: ctx.config.runtime,
        cwd: ctx.cwd,
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
    runtime: ctx.config.runtime,
    cwd: ctx.cwd,
    explain,
    vectorCandidates,
    ...tuning,
  });
}

/** Adds memories reached by walking the entity graph out from the lexical seeds. */
async function expandGraph(
  ctx: RankRecallCtx,
  opts: RankRecallOptions,
  graph: RecallGraphHops,
  state: RankState,
): Promise<void> {
  if (graph.hops <= 0) return;
  const { requested } = poolScope(opts);
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
    recallScope: requested ? { requested, additive: true } : {},
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

/** Multiplies each row's score by `multiplier(row)` (undefined leaves the row alone), traces the step and re-sorts. */
function rescore(
  opts: RankRecallOptions,
  results: SearchResult[],
  stage: string,
  multiplier: (r: SearchResult) => number | undefined,
  note?: string,
): SearchResult[] {
  return byScore(
    results.map((r) => {
      const mult = multiplier(r);
      if (mult === undefined) return r;
      const next = { ...r, score: r.score * mult };
      const step = { stage, multiplier: mult, scoreBefore: r.score, scoreAfter: next.score };
      return traced(opts, r, next, note === undefined ? step : { ...step, note });
    }),
  );
}

function demoteConflictPeers(opts: RankRecallOptions, state: RankState): void {
  // Recorded conflicts only: a lexical-overlap gate once wrecked benchmark recall. Down-rank, never delete.
  const presentIds = new Set(state.results.map((r) => r.entry.id));
  state.results = rescore(opts, state.results, 'interference', (r) =>
    (r.entry.conflictsWith || []).some((peerId) => presentIds.has(peerId)) ? CONFLICT_PEER_MULTIPLIER : undefined,
  );
}

function applyValueAware(opts: RankRecallOptions, state: RankState): void {
  // Wider clamp than the always-on outcome boost, so outcome history can decide the order.
  state.results = rescore(opts, state.results, 'value', (r) => {
    const pos = r.entry.outcomePositive ?? 0;
    const neg = r.entry.outcomeNegative ?? 0;
    if (pos === 0 && neg === 0) return undefined;
    return Math.max(VALUE_MULT_MIN, Math.min(VALUE_MULT_MAX, 1 + VALUE_MULT_SLOPE * Math.tanh(pos - neg)));
  });
}

function applyUtilityRank(opts: RankRecallOptions, state: RankState): void {
  state.results = rescore(opts, state.results, 'utility', (r) => {
    const strength = isJsonNumber(r.entry.strength) ? r.entry.strength : 1.0;
    return (
      (STRENGTH_RANK_FLOOR + STRENGTH_RANK_SPAN * strength) *
      (1 - Math.min(UTILITY_LENGTH_PENALTY_CAP, (r.tokens || 0) / UTILITY_LENGTH_TOKENS))
    );
  });
}

function reorderResults(opts: RankRecallOptions, state: RankState): void {
  if (opts.evcAdaptive && state.results.length >= 2) state.results = newestOnTopicFirst(opts.query, state.results);
  if (opts.filterConflicts) {
    dropUnless(state, (r) => !r.entry.supersededBy);
    demoteConflictPeers(opts, state);
  }
  if (opts.valueAware && state.results.length >= 1) applyValueAware(opts, state);
  if (opts.rerankUtility) applyUtilityRank(opts, state);
}

// newestOnTopicFirst acts when the top hits overlap this much; it keeps rows near the best score or covering the query.
const NEAR_DUPLICATE_OVERLAP_MIN = 0.4;
const SCORE_FLOOR_FRACTION = 0.5;
const QUERY_COVERAGE_MIN = 0.6;
const GOAL_TAG_BOOST = 1.5;
// The near-duplicate check looks at this many top hits; the re-ordered pool is three times that, at least 9.
const NEAR_DUPLICATE_WINDOW = 3;
const NEAR_DUPLICATE_POOL_MIN = 9;

/** When the top hits are near-duplicates (same topic, different facts), surface the newest on-topic row first. */
function newestOnTopicFirst(query: string, results: SearchResult[]): SearchResult[] {
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
  config: HippoConfig,
): Promise<SearchResult[]> {
  const rerankerOptions = { topK: reranker.topK, clef: config.runtime?.clef };
  // The reranker's score becomes `score` so later stages that sort by score keep its order.
  return applyReranker(opts.query, results, reranker.fn, rerankerOptions, (r) =>
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
    state.results = rescore(
      opts,
      state.results,
      'goal',
      (r) => (r.entry.tags?.includes(goalTag) ? GOAL_TAG_BOOST : undefined),
      `--goal ${goalTag}`,
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
  return rescore(opts, results, 'retrieval-count-downweight', (r) => {
    const count = r.entry.retrievalCount ?? 0;
    return count >= threshold ? undefined : Math.max(SALIENCE_MIN_MULTIPLIER, count / threshold);
  });
}

function dropUnless(state: RankState, keep: (r: SearchResult) => boolean): void {
  const before = state.results.length;
  state.results = state.results.filter(keep);
  state.droppedPreRank += before - state.results.length;
}
