import type { DatabaseSyncLike } from '../../src/db/index.js';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { localGoalRecallRows } from '../../src/store/sqlite/goals.js';
import { boostByGoals, type GoalStackBoost, type GoalStackBoostOptions } from '../../src/domain/search/goal-boost.js';
import { activeGoalsWithPolicies } from './root-forms.js';

/** The recall path's goal boost in one call: the store's active goals, the boost, and the log cut to local rows as finishRecall cuts it. */
export function sessionGoalBoost<R extends { entry: MemoryEntry; score: number }>(
  root: string,
  db: DatabaseSyncLike,
  rows: R[],
  opts: GoalStackBoostOptions,
): GoalStackBoost<R> {
  const boost = boostByGoals(
    rows,
    activeGoalsWithPolicies(root, { sessionId: opts.sessionId, tenantId: opts.tenantId }),
    opts,
  );
  return { results: boost.results, log: localGoalRecallRows(db, boost.log) };
}
