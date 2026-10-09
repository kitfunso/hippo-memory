import type { DatabaseSyncLike } from '../../src/db.js';
import type { MemoryEntry } from '../../src/memory.js';
import {
  activeGoalsWithPolicies, boostByGoals, localGoalRecallRows, type GoalStackBoost, type GoalStackBoostOpts,
} from '../../src/store/goals.js';

/** The recall path's goal boost in one call: the store's active goals, the boost, and the log cut to local rows as finishRecall cuts it. */
export function sessionGoalBoost<R extends { entry: MemoryEntry; score: number }>(
  root: string, db: DatabaseSyncLike, rows: R[], opts: GoalStackBoostOpts,
): GoalStackBoost<R> {
  const boost = boostByGoals(rows, activeGoalsWithPolicies(root, { sessionId: opts.sessionId, tenantId: opts.tenantId }), opts);
  return { results: boost.results, log: localGoalRecallRows(db, boost.log) };
}
