// The one recall ranker's entry point: rankRecall runs the pool, search and stage steps for a profile.
import type { EvalSwitches } from '../../base/memory/eval-switches.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { RerankerFn } from '../../base/ports/reranker.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import {
  DEFAULT_RECALL_BUDGET,
  type ResultCost,
  type SearchResult,
} from '../../base/rank/search-types.js';
import type { StoreWith } from '../../base/ports/store.js';
import type { RecallBoostOptions } from './types.js';
import type { Context } from '../types.js';
import type { RecallProfile } from './profiles.js';
import type { GoalRecallLogRow } from '../../base/ports/store/recall-writes.js';
import type { ActiveGoals } from '../../base/ports/store/types.js';
import { loadRecallPool, searchPool } from './rank-search.js';
import { type RankState, rankStages } from './rank-stages.js';

/** A store rankRecall reads, with the config that names its embedding model. */
export interface RankSource {
  readonly store: StoreWith<never, 'graphReads'>;
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
  /** Fires when the request passes its deadline: the later stages are skipped, and the query
   * embedding and the reranker's call stop. */
  signal?: AbortSignal;
}

/** Search-engine choice and tuning; tuning left unset takes the engine's own default. */
export interface RankRecallEngine {
  /** Set when the request names an engine (HTTP `mode=hybrid`). Without it, a 'position' profile
   * keeps the load order. */
  engineNamed?: boolean;
  multihop: boolean;
  /** Graph-stream rrf fusion over the local store; hop and seed counts fall back to the engine
   * defaults. */
  graphStream?: RecallGraphStream;
  mmr?: boolean;
  mmrLambda?: number;
  localBump?: number;
  minResults?: number;
  /** Score breakdowns for `hippo explain`. */
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
export interface RankRecallOptions extends RankRecallFilters, RankRecallEngine, RankRecallStages {
  query: string;
  /** Tokens the engines may spend, priced by `cost`; a 'band' profile spends no budget. */
  budget?: number;
  /** Price of one result, usually the tokens its printed line takes. */
  cost?: ResultCost;
  /** Stops a 'budget' profile's list. */
  limit?: number;
  /** Sizes the lexical load, 200 rows when unset. */
  scorerWindow?: number;
  /** Record a rerank trace step for each score change. */
  why?: boolean;
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

/** The request once its profile is applied: what the engines may spend and where the list stops. */
export interface SettledOptions extends RankRecallOptions {
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
    limit: request.limit ?? Infinity,
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
    signal: ctx.signal,
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
  ctx.signal?.throwIfAborted();
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
