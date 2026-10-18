// The goal options the Goals group takes.
import type { PolicyType } from './types.js';

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
