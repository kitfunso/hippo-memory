import type { RerankStep } from '../../core/search-types.js';
import type { OriginFilter, AppendAuditOpts } from './types.js';

/** The arguments of `loadRecallSearchEntries` after the query, by name. */
export interface RecallSearchArgs {
  readonly limit: number;
  readonly tenantId: string;
  readonly requestedScope?: string;
  readonly explicitScopeMode: 'exact' | 'additive';
  readonly includeSuperseded: boolean;
  readonly originProjects?: OriginFilter;
  /** The caller's personal scope, which the default deny admits; undefined admits no personal row. */
  readonly ownScope: string | undefined;
}

/** Everything one recall writes once its reply is decided, so a store writes it on one connection. */
export interface RecallWrites {
  /** Insert or ignore on (memory_id, goal_id), so the first row wins, a duplicate
   * inside this batch included. First drop a row whose memory_id is in no memories
   * row of this store, whatever that row's tenant, as `localGoalRecallRows` does. */
  readonly goalLog: readonly GoalRecallLogRow[];
  /** In the order they happened. */
  readonly audit: readonly AppendAuditOpts[];
  readonly trace?: RecallTraceInput;
  /** Nothing when `recallBoostAblated`. Each id found, in `tenantId` when set, gets the retrieval_count,
   * last_retrieved, half_life_days and strength `markRetrieved` computes from the row read before any update, so a
   * repeated id moves once. */
  readonly strengthen?: { readonly ids: readonly string[]; readonly opts: StrengthenOptions };
}

/** One `goal_recall_log` row: a boosted local memory recalled while its goal was active. */
export interface GoalRecallLogRow {
  goalId: string;
  memoryId: string;
  tenantId: string;
  sessionId: string;
  recalledAt: string;
  score: number;
}

/** Input to `writeRecallTrace`. */
export interface RecallTraceInput {
  tenantId: string;
  sessionId?: string | null;
  pipeline: 'api' | 'cli' | 'context' | 'mcp';
  /** Raw query text. NEVER persisted — only its sha256/16 hash + length are
   *  stored (GDPR Path A / audit convention, CLI). */
  query: string;
  /** True when the caller ran with explain/--why (per-result rerank steps
   *  may be present). Defaults to false. */
  explainMode?: boolean;
  /** Results in returned rank order (index 0 = rank 1). */
  results: RecallTraceResultInput[];
}

/** One ranked result to persist alongside its trace row. */
export interface RecallTraceResultInput {
  memoryId: string;
  score: number;
  /** Per-stage rerank steps when the caller ran with explain/--why; omitted
   *  (or empty) persists `rerank_json` as NULL. */
  rerankSteps?: RerankStep[];
}

/** The caller passes the eval-only recall-boost ablation switch, so the store never reads experiment config itself. */
export interface StrengthenOptions {
  readonly tenantId: string;
  readonly recallBoostAblated: boolean;
}
