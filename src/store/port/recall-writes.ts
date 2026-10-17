import type { OriginFilter } from '../search-rows.js';
import type { GoalRecallLogRow } from '../goals.js';
import type { AppendAuditOpts } from '../audit.js';
import type { RecallTraceInput } from '../recall-trace.js';
import type { StrengthenOptions } from '../entry-writes.js';

/** The arguments of `loadRecallSearchEntries` after the query, by name. */
export interface RecallSearchArgs {
  readonly limit: number;
  readonly tenantId?: string;
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
