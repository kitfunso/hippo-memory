// The goal options the Goals group takes.
import type { PolicyType, Goal } from './types.js';

/** Level a pushed goal gets when the caller names none. */
export const DEFAULT_GOAL_LEVEL = 0;

export interface PushGoalOptions {
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

export interface CompleteGoalOptions {
  outcomeScore?: number;
  /** When true, skip the strength-multiplier propagation (default false); status still goes to 'completed' and
   * `outcome_score` is still recorded. The idempotency guard returns early on a second `completeGoal` call before this
   * flag is read. */
  noPropagate?: boolean;
}

export interface Goals {
  push(tenantId: string, goal: Omit<PushGoalOptions, 'tenantId'>): Promise<Goal>;
  /** Every status, for `hippo goal list --all`; active-only reads use base `activeGoals`. */
  sessionGoals(tenantId: string, sessionId: string): Promise<Goal[]>;
  /** The tenant's goal by id; another tenant's goal, like an unknown id, changes nothing. Suspend and resume alike. */
  complete(tenantId: string, goalId: string, opts: CompleteGoalOptions): Promise<void>;
  suspend(tenantId: string, goalId: string): Promise<void>;
  resume(tenantId: string, goalId: string): Promise<void>;
}
