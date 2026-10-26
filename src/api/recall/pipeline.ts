// The one recall ranker: every recall loads, searches, expands, re-ranks and filters here under the
// profile its caller picks, with no writes and no direct output. Callers own parsing, printing,
// budget fitting and persistence.

import type { EvalSwitches } from '../../base/memory/eval-switches.js';
import { oneCopyPerMemory } from '../context-select.js';
import { compareEntryIdentity, compareScoresDesc } from '../../base/rank/compare.js';
import { boostByGoals } from '../../domain/search/goal-boost.js';
import { graphExpandRecall } from '../../domain/graph/recall.js';
import { DEFAULT_GRAPH_STREAM_WEIGHT } from '../../domain/graph/stream.js';
import { Layer, type MemoryEntry } from '../../base/memory/entry.js';
import { rankMultihop } from '../../domain/search/multihop.js';
import type { PhysicsConfig } from '../../base/rank/physics-config.js';
import {
  passesCliRecallScopeFilter,
  passesScopeFilterForRecall,
  recallScopeFilter,
} from '../../base/scope/recall-scope.js';
import type { RerankerFn } from '../../base/ports/reranker.js';
import { currentEntries } from '../../domain/search/as-of.js';
import {
  outcomeNudge,
  rankStrength,
  STRENGTH_RANK_FLOOR,
  STRENGTH_RANK_SPAN,
} from '../../domain/search/boosts.js';
import { hybridSearch, vectorSourceOf } from '../../domain/search/hybrid.js';
import { applyReranker } from '../../domain/search/rerank.js';
import { searchByEngine } from '../../domain/search/engine.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import {
  CONFLICT_PEER_MULTIPLIER,
  DEFAULT_RECALL_BUDGET,
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
import type { HippoStore } from '../../base/ports/store.js';
import { isJsonNumber } from '../../base/util/json.js';
import { currentSignal } from '../../base/util/request-scope.js';
import { textOverlap, tokenize as tokenizeQuery } from '../../base/util/tokenize.js';
import { estimateTokens } from '../../base/util/token-text.js';
import type { HybridVectorCandidates } from '../../domain/search/vector.js';
import type { RecallBoostOptions, RecallWindowOptions } from './types.js';
import type { Context } from '../types.js';
import type { RecallProfile } from './profiles.js';
import type { GoalRecallLogRow } from '../../base/ports/store/recall-writes.js';
import type { ActiveGoals } from '../../base/ports/store/types.js';

/** A store rankRecall reads, with the config that names its embedding model. */
export interface RankSource {
  readonly store: HippoStore;
  readonly config: HippoConfig;
  readonly onHippoDb?: boolean;
}

/** Stores rankRecall reads and where it sends operator notes. */
export interface RankRecallCtx extends RankSource {
  /** A second store searched beside `store`; leave undefined when there is none. Passing `store`
   * itself reads it twice but walks its graph once. */
  global?: RankSource;
  tenantId: string;
  /** Builds the provider that embeds the query for each store's vector arm. */
  embedderFor: EmbedderFor;
  /** The folder whose path segments boost a memory. Without it, no path boost applies. */
  cwd?: string;
  /** The strength model and rank switches the context's root read; absent, production ranking. */
  switches?: EvalSwitches;
  /** The instant every memory is scored at. */
  now: Date;
  /** Receives each operator note when the pipeline reaches it, so it interleaves with other
   * stderr in order. */
  note?: (line: string) => void;
}

/** Search-engine choice and tuning; tuning left unset takes the engine's own default. */
export interface RecallSearchOptions {
  usePhysics: boolean;
  /** Set when the request names an engine (HTTP `mode=hybrid` or `physics`). Without it, a
   * 'position' profile keeps the load order. */
  engineNamed?: boolean;
  physicsConfig: PhysicsConfig;
  multihop: boolean;
  /** Graph-stream rrf fusion over the local store; hop and seed counts fall back to the engine
   * defaults. */
  graphStream?: RecallGraphStream;
  mmr?: boolean;
  mmrLambda?: number;
  localBump?: number;
  minResults?: number;
  /** Score breakdowns for `hippo explain`; explain's physics call also leaves out minResults and
   * includeSuperseded. */
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

/** The rows a ranking may return, and the scope its boosts favour. */
export interface RankRecallFilters {
  includeSuperseded: boolean;
  asOf?: string;
  /** `--scope` unlocks that envelope scope on top of the default-admitted set. Under `scopeMode:
   * 'exact'` it is the only scope read. */
  explicitScope: string | null;
  /** 'additive' (the default) for the CLI operator, who has no identity; 'exact' for an API
   * caller. */
  scopeMode?: 'additive' | 'exact';
  /** The API caller's own personal scope, which the default deny still admits. */
  ownScope?: string;
  /** The caller's project names: other projects' rows stay out, user-global ones stay in. */
  originProjects?: readonly string[];
  /** Scope used for boosting only, never for filtering. Without it, the engine boosts the
   * store's runtime active scope. */
  activeScope?: string | null;
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
}

/** Everything that shapes one ranking, already parsed and validated. */
export interface RankRecallOptions extends RankRecallFilters, RankRecallStages {
  query: string;
  /** Tokens the engines may spend, priced by `cost`; a 'band' profile spends no budget. */
  budget?: number;
  /** Price of one result, usually the tokens its printed line takes. */
  cost?: ResultCost;
  /** `limit` stops a 'budget' profile's list; `scorerWindow` sizes the lexical load, 200 rows
   * when unset. */
  window: Pick<RecallWindowOptions, 'limit' | 'scorerWindow'>;
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
  /** The goals the ranked goal pass read, so a band pass need not read them again. It is null
   * when the pass had no session to read for, and absent when the profile runs no ranked pass. */
  goals?: ActiveGoals | null;
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
  goals?: ActiveGoals | null;
}

/** The request once its profile is applied: what the engines may spend and where the list stops. */
interface SettledOptions extends RankRecallOptions {
  readonly budget: number;
  readonly limit: number;
}

// A band profile ranks every row. Its caller composes the band from the list and makes the cut.
const WHOLE_LIST = { budget: Infinity, cost: undefined, limit: Infinity } as const;

function settle(request: RankRecallOptions, profile: RecallProfile): SettledOptions {
  if (profile.resultCount === 'band') return { ...request, ...WHOLE_LIST };
  return {
    ...request,
    budget: request.budget ?? DEFAULT_RECALL_BUDGET,
    limit: request.window.limit ?? Infinity,
  };
}

/** The ranker's reads through an api Context: its store, the embedding model its config names,
 * and its folder. */
export function rankCtxOf(ctx: Context): RankRecallCtx {
  return {
    store: ctx.store,
    config: ctx.config,
    onHippoDb: ctx.reach?.isHippoDb,
    tenantId: ctx.tenantId,
    embedderFor: ctx.infra.embedderFor,
    cwd: ctx.infra.machine.cwd,
    switches: ctx.infra.evalSwitches,
    now: ctx.infra.clock(),
  };
}

/** Ranks memories for a query under the caller's `profile`; notes go to `ctx.note`, and the
 * caller supplies the cost function and reranker in `request` and writes the returned goal-log
 * rows. */
export async function rankRecall(
  ctx: RankRecallCtx,
  request: RankRecallOptions,
  profile: RecallProfile,
): Promise<RankRecallResult> {
  const opts = settle(request, profile);
  const reach: RankRecallCtx = profile.globalReach ? ctx : { ...ctx, global: undefined };
  const pool = await loadRecallPool(reach, opts, profile);
  const state: RankState = {
    results: [],
    droppedPreRank: pool.dropped,
    graphAdded: 0,
    goalRecallLog: [],
  };
  state.results = await searchPool(reach, opts, pool, profile);
  // A request past its deadline during the search has no caller left for the later stages.
  currentSignal()?.throwIfAborted();
  await rankStages(reach, opts, state, profile);
  if (opts.limit < state.results.length) state.results = state.results.slice(0, opts.limit);
  return {
    results: state.results,
    localEntries: pool.local,
    globalEntries: pool.global,
    totalCandidates: pool.total,
    droppedPreRank: state.droppedPreRank,
    graphAdded: state.graphAdded,
    goalRecallLog: state.goalRecallLog,
    goals: state.goals,
  };
}

/** The stages after the search, in order: graph expansion, re-rank, goal boost, salience, then
 * the outcome and layer filters. */
async function rankStages(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  state: RankState,
  profile: RecallProfile,
): Promise<void> {
  if (opts.graphHops) await expandGraph(ctx, opts, opts.graphHops, state);
  reorderResults(opts, state);
  if (opts.reranker) {
    state.results = await applyRecallReranker(opts, opts.reranker, state.results, ctx.config);
  }
  if (profile.goalBoost.ranked) await applyGoalBoosts(ctx, opts, state);
  if (opts.salienceThreshold !== undefined) {
    state.results = applySalience(opts, opts.salienceThreshold, state.results);
  }
  const { outcome, layer } = opts;
  if (outcome) {
    dropUnless(state, (r) => r.entry.layer !== Layer.Trace || r.entry.traceOutcome === outcome);
  }
  if (layer) dropUnless(state, (r) => r.entry.layer === layer);
}

interface PoolScope {
  /** An explicit --scope unlocks that envelope scope. The regex-only `<source>:private:*` deny
   * is the JS half of the rule. */
  requested: string | undefined;
  /** An as-of read needs the rows a later write superseded. */
  loadSuperseded: boolean;
}

function poolScope(opts: RankRecallOptions): PoolScope {
  return {
    requested: opts.explicitScope || undefined,
    loadSuperseded: opts.includeSuperseded || Boolean(opts.asOf),
  };
}

/** The JS half of the load's scope rule: the CLI's additive unlock, or an API caller's exact
 * scope and own scope. */
function poolAdmits(opts: RankRecallOptions): (e: MemoryEntry) => boolean {
  const { requested } = poolScope(opts);
  return opts.scopeMode === 'exact'
    ? (e) => passesScopeFilterForRecall(e.scope ?? null, requested, opts.ownScope)
    : (e) => passesCliRecallScopeFilter(e.scope ?? null, requested);
}

async function loadRecallPool(
  ctx: RankRecallCtx,
  opts: RankRecallOptions,
  profile: RecallProfile,
): Promise<RecallPool> {
  const { requested, loadSuperseded } = poolScope(opts);
  const load = {
    limit: Math.max(
      opts.window.scorerWindow ?? DEFAULT_SEARCH_CANDIDATE_LIMIT,
      profile.candidateFloor,
    ),
    tenantId: ctx.tenantId,
    requestedScope: requested,
    explicitScopeMode: opts.scopeMode ?? 'additive',
    includeSuperseded: loadSuperseded,
    originProjects: opts.originProjects,
    ownScope: opts.ownScope,
  };
  // The two stores are independent, so their reads overlap; Promise.all keeps the local-then-global
  // order.
  const reads = await Promise.all([
    ctx.store.searchRecallEntries(opts.query, load),
    ctx.global ? ctx.global.store.searchRecallEntries(opts.query, load) : Promise.resolve([]),
  ]);
  let [local, global] = reads;
  // The SQL load already left out some rows, so the total is taken before the JS filters, which
  // normally drop nothing.
  const total = local.length + global.length;
  const passes = poolAdmits(opts);
  local = local.filter(passes);
  global = global.filter(passes);
  const currentness = { asOf: opts.asOf, includeSuperseded: opts.includeSuperseded };
  local = currentEntries(local, currentness);
  global = currentEntries(global, currentness);
  return { local, global, total, dropped: total - (local.length + global.length) };
}

interface PoolSearch {
  readonly pool: RecallPool;
  /** The scope the engines boost, by the profile's `scopeBoost`; undefined leaves the engine its
   * runtime scope. */
  readonly scope: string | null | undefined;
}

function graphStreamSearch(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  graphStream: RecallGraphStream,
  { pool, scope }: PoolSearch,
): Promise<SearchResult[]> {
  const { query, budget, cost, includeSuperseded, asOf, search } = opts;
  const { mmr, mmrLambda, minResults } = search;
  noteGraphStreamLimits(ctx, pool);
  // With seedCount or fewer candidates every one is a seed and the stream degrades to the 2-list
  // fusion.
  return hybridSearch(query, pool.local, {
    budget,
    cost,
    runtime: ctx.config.runtime,
    cwd: ctx.cwd,
    switches: ctx.switches,
    now: ctx.now,
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

/** Says why the graph stream will not run as asked, rather than no-op. */
function noteGraphStreamLimits(ctx: RankRecallCtx, pool: RecallPool): void {
  // Without embeddings hybridSearch falls back to BM25-only and the stream is inert.
  if (!ctx.embedderFor(ctx.config.embeddings).isAvailable()) {
    ctx.note?.(
      '[note] --graph-stream needs embeddings (rrf fusion); none available, so the graph stream is inert. Run ' +
        '`hippo embed` first.',
    );
  }
  if (ctx.global && pool.global.length > 0) {
    ctx.note?.(
      '[note] --graph-stream searches the local store only; global graph fusion is a follow-up.',
    );
  }
}

function multihopPoolSearch(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  pool: RecallPool,
): SearchResult[] {
  const { query, budget, cost, includeSuperseded, asOf, search } = opts;
  const { minResults } = search;
  // Unlike rankBothStores below, multihop ranks one pooled list, so a shared memory's two copies
  // both compete.
  const strength = rankStrength({ switches: ctx.switches, runtime: ctx.config.runtime });
  const allEntries = oneCopyPerMemory(pool.local, pool.global, ctx.now, strength).flat();
  const globalIds = new Set(pool.global.map((e) => e.id));
  const localIds = new Set(pool.local.map((e) => e.id));
  const fromGlobal = (id: string): boolean => globalIds.has(id) && !localIds.has(id);
  const results = rankMultihop(query, allEntries, {
    budget,
    cost: cost && ((r) => cost({ ...r, isGlobal: fromGlobal(r.entry.id) })),
    minResults,
    includeSuperseded,
    asOf,
    scope: ctx.config.runtime?.activeScope ?? null,
    runtime: ctx.config.runtime,
    cwd: ctx.cwd,
    switches: ctx.switches,
    now: ctx.now,
  });
  return results.map((r) => ({ ...r, isGlobal: fromGlobal(r.entry.id) }));
}

function poolVectorCandidates(ctx: RankRecallCtx, opts: RankRecallOptions): HybridVectorCandidates {
  const { requested, loadSuperseded } = poolScope(opts);
  return {
    tenantId: ctx.tenantId,
    scope: recallScopeFilter(requested, opts.scopeMode ?? 'additive', opts.ownScope),
    includeSuperseded: loadSuperseded,
    origin: opts.originProjects,
    admit: poolAdmits(opts),
  };
}

async function searchPool(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  pool: RecallPool,
  profile: RecallProfile,
): Promise<SearchResult[]> {
  const scope = profile.scopeBoost === 'filter' ? opts.explicitScope : opts.activeScope;
  if (profile.scoreForm === 'engine') return engineSearch(ctx, opts, { pool, scope });
  // Every loaded row stays, in the order of an engine the request names; rows it leaves out keep
  // their load order.
  const ranked = opts.search.engineNamed ? await engineSearch(ctx, opts, { pool, scope }) : [];
  const order = withMissing(
    ranked.map((r) => r.entry),
    pool.local,
  );
  return order.map((entry, i) => ({
    entry,
    score: 1 - i / order.length,
    bm25: 0,
    cosine: 0,
    tokens: estimateTokens(entry.content),
  }));
}

/** The tuning each engine takes: physics takes no MMR, and an explain run takes only asOf so its
 * output stays steady. */
function engineTuning<T extends { minResults: unknown; includeSuperseded: unknown; asOf: unknown }>(
  physicsOn: boolean,
  explain: boolean,
  all: T,
): T | Pick<T, 'asOf'> | Pick<T, 'minResults' | 'includeSuperseded' | 'asOf'> {
  if (!physicsOn) return all;
  if (explain) return { asOf: all.asOf };
  return { minResults: all.minResults, includeSuperseded: all.includeSuperseded, asOf: all.asOf };
}

/** The options every engine takes the same way. */
function engineShared(ctx: RankRecallCtx, opts: SettledOptions, scope: PoolSearch['scope']) {
  return {
    budget: opts.budget,
    cost: opts.cost,
    explain: opts.search.explain,
    scope,
    runtime: ctx.config.runtime,
    cwd: ctx.cwd,
    switches: ctx.switches,
    now: ctx.now,
  };
}

async function engineSearch(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  poolSearch: PoolSearch,
): Promise<SearchResult[]> {
  const { pool, scope } = poolSearch;
  const { query, includeSuperseded, asOf, search } = opts;
  const { mmr, mmrLambda, minResults, explain } = search;
  const ranking = { mmr, mmrLambda, minResults, includeSuperseded, asOf };
  if (search.graphStream) return graphStreamSearch(ctx, opts, search.graphStream, poolSearch);
  if (search.multihop) return multihopPoolSearch(ctx, opts, pool);
  const vectorCandidates = poolVectorCandidates(ctx, opts);
  const shared = engineShared(ctx, opts, scope);
  if (ctx.global && pool.global.length > 0) {
    // The pool already holds searchBothHybrid's additive-scope load for each store, so rank it
    // rather than read both stores again.
    return rankBothStores(
      query,
      {
        local: vectorSourceOf(ctx),
        global: vectorSourceOf({ ...ctx.global, embedderFor: ctx.embedderFor }),
      },
      { local: pool.local, global: pool.global },
      vectorCandidates,
      { ...shared, ...ranking, localBump: search.localBump },
    );
  }
  const physics = search.usePhysics ? search.physicsConfig : null;
  // asOf must reach physics, or later rows leak.
  const tuning = engineTuning(physics !== null, explain, ranking);
  return searchByEngine(vectorSourceOf(ctx), query, pool.local, physics, {
    ...shared,
    vectorCandidates,
    ...tuning,
  });
}

/** `first`, then the rows of `second` that `first` does not hold. */
export function withMissing(first: MemoryEntry[], second: MemoryEntry[]): MemoryEntry[] {
  const held = new Set(first.map((e) => e.id));
  return [...first, ...second.filter((e) => !held.has(e.id))];
}

/** Adds memories reached by walking the entity graph out from the lexical seeds. */
async function expandGraph(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  graph: RecallGraphHops,
  state: RankState,
): Promise<void> {
  if (graph.hops <= 0) return;
  const { requested } = poolScope(opts);
  // Expansion both adds neighbors and evicts weak base rows, so compare id sets: a net count would
  // hide both.
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
function traced<R extends SearchResult>(
  opts: RankRecallOptions,
  prev: SearchResult,
  next: R,
  step: RerankStep,
): R {
  if (opts.why) next.rerankTrace = [...(prev.rerankTrace ?? []), step];
  return next;
}

/** Re-sort after a score change. Plain and stable on purpose: ties keep the prior rank, not a
 * content order. */
function byScore(results: SearchResult[]): SearchResult[] {
  return results.sort((a, b) => compareScoresDesc(a.score, b.score));
}

/** Multiplies each row's score by `multiplier(row)` (undefined leaves the row alone), traces the
 * step and re-sorts. */
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
  // Recorded conflicts only: a lexical-overlap gate once wrecked benchmark recall. Down-rank, never
  // delete.
  const presentIds = new Set(state.results.map((r) => r.entry.id));
  state.results = rescore(opts, state.results, 'interference', (r) =>
    (r.entry.conflictsWith || []).some((peerId) => presentIds.has(peerId))
      ? CONFLICT_PEER_MULTIPLIER
      : undefined,
  );
}

function applyValueAware(opts: RankRecallOptions, state: RankState): void {
  // Wider clamp than the always-on outcome boost, so outcome history can decide the order.
  state.results = rescore(opts, state.results, 'value', (r) => {
    const pos = r.entry.outcomePositive ?? 0;
    const neg = r.entry.outcomeNegative ?? 0;
    if (pos === 0 && neg === 0) return undefined;
    return outcomeNudge(pos - neg, {
      slope: VALUE_MULT_SLOPE,
      min: VALUE_MULT_MIN,
      max: VALUE_MULT_MAX,
    });
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
  if (opts.evcAdaptive && state.results.length >= 2) {
    state.results = newestOnTopicFirst(opts.query, state.results);
  }
  if (opts.filterConflicts) {
    dropUnless(state, (r) => !r.entry.supersededBy);
    demoteConflictPeers(opts, state);
  }
  if (opts.valueAware && state.results.length >= 1) applyValueAware(opts, state);
  if (opts.rerankUtility) applyUtilityRank(opts, state);
}

// newestOnTopicFirst acts when the top hits overlap this much; it keeps rows near the best score or
// covering the query.
const NEAR_DUPLICATE_OVERLAP_MIN = 0.4;
const SCORE_FLOOR_FRACTION = 0.5;
const QUERY_COVERAGE_MIN = 0.6;
const GOAL_TAG_BOOST = 1.5;
// The near-duplicate check looks at this many top hits; the re-ordered pool is three times that, at
// least 9.
const NEAR_DUPLICATE_WINDOW = 3;
const NEAR_DUPLICATE_POOL_MIN = 9;

/** When the top hits are near-duplicates (same topic, different facts), surface the newest
 * on-topic row first. */
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
  const poolSize = Math.min(
    results.length,
    Math.max(slice.length * NEAR_DUPLICATE_WINDOW, NEAR_DUPLICATE_POOL_MIN),
  );
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

async function applyGoalBoosts(
  ctx: RankRecallCtx,
  opts: SettledOptions,
  state: RankState,
): Promise<void> {
  const { goalTag = '', sessionId } = opts.boost ?? {};
  state.goals = null;
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
  state.goals = await ctx.store.activeGoals(session);
  const boost = boostByGoals(state.results, state.goals, {
    ...session,
    limit: opts.limit,
    now: ctx.now,
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
function applySalience(
  opts: RankRecallOptions,
  threshold: number,
  results: SearchResult[],
): SearchResult[] {
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
