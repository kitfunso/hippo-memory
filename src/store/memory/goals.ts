// The in-memory Goals group and the base activeGoals read: the goal stack held as a list, under the shared goal rules.
import type { CompleteGoalOpts, PushGoalOpts, Goals } from '../port/goals.js';
import type { GoalRecallLogRow } from '../port/recall-writes.js';
import type { ActiveGoals, GetActiveGoalsOpts, Goal, RetrievalPolicy } from '../port/types.js';
import {
  assertParentInSession,
  goalOverflow,
  newGoalId,
  outcomeMultiplier,
  pushedGoal,
  retrievalPolicyOf,
} from '../rules/goals.js';
import { byBytes } from '../rules/order.js';
import type { MemoryTables } from './tables.js';

/** The session's goals in `status` (any when unset), oldest first: created_at, then rowid. */
function sessionGoalsIn(t: MemoryTables, tenantId: string, sessionId: string, status?: Goal['status']): Goal[] {
  const order = new Map(t.goals.map((g, i) => [g, i]));
  const mine = t.goals.filter(
    (g) => g.tenantId === tenantId && g.sessionId === sessionId && (status === undefined || g.status === status),
  );
  return mine.sort((a, b) => byBytes(a.createdAt, b.createdAt) || order.get(a)! - order.get(b)!);
}

/** At the cap, the oldest active goals give way so the one about to become active fits. */
function enforceDepthCap(t: MemoryTables, tenantId: string, sessionId: string): void {
  const active = sessionGoalsIn(t, tenantId, sessionId, 'active');
  for (const goal of active.slice(0, goalOverflow(active.length))) goal.status = 'suspended';
}

function pushIn(t: MemoryTables, tenantId: string, goal: Omit<PushGoalOpts, 'tenantId'>): Goal {
  const opts: PushGoalOpts = { ...goal, tenantId };
  // Checked before the cap, since a refused push changes no goal.
  const parent = opts.parentGoalId ? t.goals.find((g) => g.id === opts.parentGoalId) : undefined;
  assertParentInSession(opts, parent);
  enforceDepthCap(t, tenantId, opts.sessionId);
  const id = newGoalId();
  const policy = opts.policy ? retrievalPolicyOf(id, opts.policy) : undefined;
  if (policy) t.policies.set(policy.id, policy);
  const row = pushedGoal(id, opts, new Date().toISOString(), policy?.id);
  t.goals.push(row);
  return { ...row };
}

/** The strength change for every memory the goal's log names, recalled in its active life. */
function propagateOutcome(t: MemoryTables, goal: Goal, completedAt: string, score: number): void {
  const multiplier = outcomeMultiplier(score);
  if (multiplier === 1) return;
  const inLife = (r: GoalRecallLogRow): boolean =>
    r.goalId === goal.id && byBytes(r.recalledAt, goal.createdAt) >= 0 && byBytes(r.recalledAt, completedAt) <= 0;
  for (const id of new Set(t.goalRecallLog.filter(inLife).map((r) => r.memoryId))) {
    const row = t.entries.get(id);
    if (row) t.entries.set(id, { ...row, strength: Math.min(1, Math.max(0, row.strength * multiplier)) });
  }
}

// Goal ids are not tenant-scoped, so complete, suspend and resume ignore the tenant.
function completeIn(t: MemoryTables, goalId: string, opts: CompleteGoalOpts): void {
  const goal = t.goals.find((g) => g.id === goalId);
  if (!goal || goal.status === 'completed') return;
  const completedAt = new Date().toISOString();
  goal.status = 'completed';
  goal.completedAt = completedAt;
  goal.outcomeScore = opts.outcomeScore;
  if (opts.outcomeScore !== undefined && !opts.noPropagate) propagateOutcome(t, goal, completedAt, opts.outcomeScore);
}

function resumeIn(t: MemoryTables, goalId: string): void {
  const goal = t.goals.find((g) => g.id === goalId);
  if (!goal || goal.status !== 'suspended') return;
  enforceDepthCap(t, goal.tenantId, goal.sessionId);
  goal.status = 'active';
}

/** The session's active goals and the policy of each that names one. */
export function activeGoalsIn(t: MemoryTables, { tenantId, sessionId }: GetActiveGoalsOpts): ActiveGoals {
  const goals = sessionGoalsIn(t, tenantId, sessionId, 'active').map((g) => ({ ...g }));
  const policies = new Map<string, RetrievalPolicy>();
  for (const goal of goals) {
    const policy = goal.retrievalPolicyId ? t.policies.get(goal.retrievalPolicyId) : undefined;
    if (policy) policies.set(goal.id, { ...policy });
  }
  return { goals, policies };
}

/** Insert or ignore on (memory, goal), keeping only rows whose memory this store holds in any tenant. */
export function logGoalRecalls(t: MemoryTables, rows: readonly GoalRecallLogRow[]): void {
  for (const row of rows) {
    const held = t.entries.has(row.memoryId);
    const logged = t.goalRecallLog.some((r) => r.memoryId === row.memoryId && r.goalId === row.goalId);
    if (held && !logged) t.goalRecallLog.push({ ...row });
  }
}

export function memoryGoals(t: MemoryTables): Goals {
  return {
    push: async (tenantId, goal) => pushIn(t, tenantId, goal),
    sessionGoals: async (tenantId, sessionId) => sessionGoalsIn(t, tenantId, sessionId).map((g) => ({ ...g })),
    complete: async (_tenantId, goalId, opts) => completeIn(t, goalId, opts),
    async suspend(_tenantId, goalId) {
      const goal = t.goals.find((g) => g.id === goalId);
      if (goal?.status === 'active') goal.status = 'suspended';
    },
    resume: async (_tenantId, goalId) => resumeIn(t, goalId),
  };
}
