// The goal stack's rules, once for both adapters: its ids, its depth cap, the parent check, a new goal and policy, and
// the strength a completed goal passes to the memories recalled under it.
import { generateId } from '../../base/memory/memory.js';
import type { PushGoalOpts } from '../port/goals.js';
import type { Goal, RetrievalPolicy } from '../port/types.js';

// The CLI prints these ids and the sequential-learning adapter reads them back as 16 hex characters.
const GOAL_ID_CHARS = 16;
const MAX_ACTIVE_GOAL_DEPTH = 3;
const POSITIVE_OUTCOME_THRESHOLD = 0.7;
const NEGATIVE_OUTCOME_THRESHOLD = 0.3;
const STRENGTH_BOOST = 1.1;
const STRENGTH_DECAY = 0.85;

export const newGoalId = (): string => generateId('g', GOAL_ID_CHARS);

/** How many of a session's oldest active goals give way so one more fits under the depth cap. */
export const goalOverflow = (activeCount: number): number => Math.max(0, activeCount - MAX_ACTIVE_GOAL_DEPTH + 1);

/** Throws unless the push names no parent or one of its own tenant and session. */
export function assertParentInSession(
  opts: PushGoalOpts,
  parent: { readonly tenantId: string; readonly sessionId: string } | undefined,
): void {
  if (!opts.parentGoalId) return;
  if (!parent) throw new Error(`parent goal not found: ${opts.parentGoalId}`);
  if (parent.tenantId !== opts.tenantId || parent.sessionId !== opts.sessionId) {
    throw new Error(`parent goal ${opts.parentGoalId} belongs to a different (tenant, session)`);
  }
}

/** The policy row a push with `policy` stores, each weight 1 unless given. */
export function retrievalPolicyOf(goalId: string, policy: NonNullable<PushGoalOpts['policy']>): RetrievalPolicy {
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

/** The goal a push stores. */
export function pushedGoal(id: string, opts: PushGoalOpts, createdAt: string, policyId: string | undefined): Goal {
  return {
    id,
    sessionId: opts.sessionId,
    tenantId: opts.tenantId,
    goalName: opts.goalName,
    level: opts.level ?? 0,
    parentGoalId: opts.parentGoalId,
    status: 'active',
    successCondition: opts.successCondition,
    retrievalPolicyId: policyId,
    createdAt,
  };
}

/** The factor a completed goal's score applies to the strength of each memory recalled in its active life. */
export function outcomeMultiplier(score: number): number {
  if (score >= POSITIVE_OUTCOME_THRESHOLD) return STRENGTH_BOOST;
  return score < NEGATIVE_OUTCOME_THRESHOLD ? STRENGTH_DECAY : 1;
}
