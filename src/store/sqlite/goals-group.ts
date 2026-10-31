// hippo.db's Goals group: the goal stack's writes and the every-status listing.
import { completeGoal, getSessionGoals, pushGoal, resumeGoal, suspendGoal } from '../goals.js';
import type { Goals } from '../port-groups.js';
import type { Sync } from '../port.js';

export function sqliteGoals(hippoRoot: string): Sync<Goals> {
  return {
    push: (tenantId, goal) => pushGoal(hippoRoot, { ...goal, tenantId }),
    sessionGoals: (tenantId, sessionId) => getSessionGoals(hippoRoot, { sessionId, tenantId }),
    // Goal ids are not tenant-scoped in hippo.db, so these ignore the tenant; the api checks the host admin.
    complete: (_tenantId, goalId, opts) => completeGoal(hippoRoot, goalId, opts),
    suspend: (_tenantId, goalId) => suspendGoal(hippoRoot, goalId),
    resume: (_tenantId, goalId) => resumeGoal(hippoRoot, goalId),
  };
}

/** The group as a served store answers it: a throw rejects as another store's would. */
export function servedGoals(sync: Sync<Goals>): Goals {
  return {
    push: async (tenantId, goal) => sync.push(tenantId, goal),
    sessionGoals: async (tenantId, sessionId) => sync.sessionGoals(tenantId, sessionId),
    complete: async (tenantId, goalId, opts) => sync.complete(tenantId, goalId, opts),
    suspend: async (tenantId, goalId) => sync.suspend(tenantId, goalId),
    resume: async (tenantId, goalId) => sync.resume(tenantId, goalId),
  };
}
