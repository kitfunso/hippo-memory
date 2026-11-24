import type { EvalSwitches } from '../../base/memory/eval-switches.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { PhysicsConfig } from '../../base/rank/physics-config.js';
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
  readonly store: StoreWith<never, 'vectors' | 'graphReads'>;
  readonly config: HippoConfig;
  readonly onHippoDb?: boolean;
}

/** Stores rankRecall reads and where it sends operator notes. */
export interface RankRecallCtx extends RankSource {
  global?: RankSource;
  tenantId: string;
  embedderFor: EmbedderFor;
  cwd?: string;
  switches?: EvalSwitches;
  now: Date;
  note?: (line: string) => void;
  signal?: AbortSignal;
}

/** Search-engine choice and tuning; tuning left unset takes the engine's own default. */
export interface RankRecallEngine {
  usePhysics: boolean;
  engineNamed?: boolean;
  physicsConfig: PhysicsConfig;
  multihop: boolean;
  graphStream?: RecallGraphStream;
  mmr?: boolean;
  mmrLambda?: number;
  localBump?: number;
  minResults?: number;
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
  explicitScope: string | null;
  scopeMode?: 'additive' | 'exact';
  ownScope?: string;
  originProjects?: readonly string[];
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
  budget?: number;
  cost?: ResultCost;
  limit?: number;
  scorerWindow?: number;
  why?: boolean;
}

/** Ranked results and what the caller needs to report and persist them. */
export interface RankRecallResult {
  results: SearchResult[];
  localEntries: MemoryEntry[];
  globalEntries: MemoryEntry[];
  totalCandidates: number;
  droppedPreRank: number;
  graphAdded: number;
  goalRecallLog: GoalRecallLogRow[];
  goals?: ActiveGoals | null;
}

/** The request once its profile is applied: what the engines may spend and where the list stops. */
export interface SettledOptions extends RankRecallOptions {
  readonly budget: number;
  readonly limit: number;
}

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
