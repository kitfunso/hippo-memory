// hippo.db's Goals group: the goal stack's writes and the every-status listing.
import { completeGoalAt, getSessionGoalsAt, pushGoalAt, resumeGoalAt, suspendGoalAt } from './goals.js';
import type { Goals } from '../port-groups.js';
import type { Sync } from '../port.js';
import { type OnHandle } from './open.js';

export function sqliteGoals(on: OnHandle): Sync<Goals> {
  return {
    push: (tenantId, goal) => on((db) => pushGoalAt(db, { ...goal, tenantId })),
    sessionGoals: (tenantId, sessionId) => on((db) => getSessionGoalsAt(db, { sessionId, tenantId })),
    // Goal ids are not tenant-scoped in hippo.db, so these ignore the tenant; the api checks the host admin.
    complete: (_tenantId, goalId, opts) => on((db) => completeGoalAt(db, goalId, opts)),
    suspend: (_tenantId, goalId) => on((db) => suspendGoalAt(db, goalId)),
    resume: (_tenantId, goalId) => on((db) => resumeGoalAt(db, goalId)),
  };
}
