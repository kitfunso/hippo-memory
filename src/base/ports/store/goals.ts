// The goal options the Goals group takes.
import type { PolicyType, Goal } from './types.js';

export interface PushGoalOpts {
  sessionId: string;
  tenantId: string;
  goalName: string;
  level?: number;
  parentGoalId?: string;
  successCondition?: string;
  policy?: {
    policyType: PolicyType;
    weightSchemaFit?: number;
    weightRecency?: number;
    weightOutcome?: number;
    errorPriority?: number;
  };
}

export interface CompleteGoalOpts {
  outcomeScore?: number;
  /** When true, skip the strength-multiplier propagation (default false); status still goes to 'completed' and
   * `outcome_score` is still recorded. The idempotency guard returns early on a second `completeGoal` call before this
   * flag is read. */
  noPropagate?: boolean;
}

export interface Goals {
  push(tenantId: string, goal: Omit<PushGoalOpts, 'tenantId'>): Promise<Goal>;
  /** Every status, for `hippo goal list --all`; active-only reads use base `activeGoals`. */
  sessionGoals(tenantId: string, sessionId: string): Promise<Goal[]>;
  /** By id. Goal ids are not tenant-scoped in hippo.db, so that store ignores `tenantId` and the api keeps the
   * host-admin check; a tenant-keyed store filters on it. */
  complete(tenantId: string, goalId: string, opts: CompleteGoalOpts): Promise<void>;
  suspend(tenantId: string, goalId: string): Promise<void>;
  resume(tenantId: string, goalId: string): Promise<void>;
}
