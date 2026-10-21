// The in-memory Goals group and the base activeGoals read: hippo.db's goal stack, its depth cap and the strength a
// completed goal passes to the memories recalled under it.
import { generateId } from '../../base/memory/memory.js';
import type { CompleteGoalOpts, PushGoalOpts, Goals } from '../port/goals.js';
import type { GoalRecallLogRow } from '../port/recall-writes.js';
import type { ActiveGoals, GetActiveGoalsOpts, Goal, RetrievalPolicy } from '../port/types.js';
import { byBytes } from '../rules/order.js';
import type { MemoryTables } from './tables.js';

// The CLI prints these ids and the sequential-learning adapter reads them back as 16 hex characters.
const GOAL_ID_CHARS = 16;
const MAX_ACTIVE_GOAL_DEPTH = 3;
const POSITIVE_OUTCOME_THRESHOLD = 0.7;
const NEGATIVE_OUTCOME_THRESHOLD = 0.3;
const STRENGTH_BOOST = 1.1;
const STRENGTH_DECAY = 0.85;

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
  const overflow = active.length - MAX_ACTIVE_GOAL_DEPTH + 1;
  for (const goal of active.slice(0, Math.max(0, overflow))) goal.status = 'suspended';
}

// Checked before the cap: hippo.db rolls the cap back with a refused push, so nothing may change first here.
function assertParentInSession(t: MemoryTables, opts: PushGoalOpts): void {
  if (!opts.parentGoalId) return;
  const parent = t.goals.find((g) => g.id === opts.parentGoalId);
  if (!parent) throw new Error(`parent goal not found: ${opts.parentGoalId}`);
  if (parent.tenantId !== opts.tenantId || parent.sessionId !== opts.sessionId) {
    throw new Error(`parent goal ${opts.parentGoalId} belongs to a different (tenant, session)`);
  }
}

function policyOf(goalId: string, policy: NonNullable<PushGoalOpts['policy']>): RetrievalPolicy {
  return {
    id: generateId('rp', GOAL_ID_CHARS),
    goalId,
    policyType: policy.policyType,
    weightSchemaFit: policy.weightSchemaFit ?? 1.0,
    weightRecency: policy.weightRecency ?? 1.0,
    weightOutcome: policy.weightOutcome ?? 1.0,
    errorPriority: policy.errorPriority ?? 1.0,
  };
}

function pushIn(t: MemoryTables, tenantId: string, goal: Omit<PushGoalOpts, 'tenantId'>): Goal {
  const opts: PushGoalOpts = { ...goal, tenantId };
  assertParentInSession(t, opts);
  enforceDepthCap(t, tenantId, opts.sessionId);
  const id = generateId('g', GOAL_ID_CHARS);
  const policy = opts.policy ? policyOf(id, opts.policy) : undefined;
  if (policy) t.policies.set(policy.id, policy);
  const row: Goal = {
    id,
    sessionId: opts.sessionId,
    tenantId,
    goalName: opts.goalName,
    level: opts.level ?? 0,
    parentGoalId: opts.parentGoalId,
    status: 'active',
    successCondition: opts.successCondition,
    retrievalPolicyId: policy?.id,
    createdAt: new Date().toISOString(),
  };
  t.goals.push(row);
  return { ...row };
}

/** The strength change for every memory the goal's log names, recalled in its active life. */
function propagateOutcome(t: MemoryTables, goal: Goal, completedAt: string, score: number): void {
  const multiplier =
    score >= POSITIVE_OUTCOME_THRESHOLD ? STRENGTH_BOOST : score < NEGATIVE_OUTCOME_THRESHOLD ? STRENGTH_DECAY : 1;
  if (multiplier === 1) return;
  const inLife = (r: GoalRecallLogRow): boolean =>
    r.goalId === goal.id && byBytes(r.recalledAt, goal.createdAt) >= 0 && byBytes(r.recalledAt, completedAt) <= 0;
  for (const id of new Set(t.goalRecallLog.filter(inLife).map((r) => r.memoryId))) {
    const row = t.entries.get(id);
    if (row) t.entries.set(id, { ...row, strength: Math.min(1, Math.max(0, row.strength * multiplier)) });
  }
}

// Goal ids are not tenant-scoped in hippo.db, so complete, suspend and resume ignore the tenant there and here.
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
