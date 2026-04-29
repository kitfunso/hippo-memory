// src/goals.ts
import { randomUUID } from 'node:crypto';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';

export type GoalStatus = 'active' | 'suspended' | 'completed';
export type PolicyType = 'schema-fit-biased' | 'error-prioritized' | 'recency-first' | 'hybrid';

export interface GoalRow {
  id: string;
  session_id: string;
  tenant_id: string;
  goal_name: string;
  level: number;
  parent_goal_id: string | null;
  status: GoalStatus;
  success_condition: string | null;
  retrieval_policy_id: string | null;
  created_at: string;
  completed_at: string | null;
  outcome_score: number | null;
}

export interface Goal {
  id: string;
  sessionId: string;
  tenantId: string;
  goalName: string;
  level: number;
  parentGoalId?: string;
  status: GoalStatus;
  successCondition?: string;
  retrievalPolicyId?: string;
  createdAt: string;
  completedAt?: string;
  outcomeScore?: number;
}

export interface RetrievalPolicy {
  id: string;
  goalId: string;
  policyType: PolicyType;
  weightSchemaFit: number;
  weightRecency: number;
  weightOutcome: number;
  errorPriority: number;
}

export const MAX_ACTIVE_GOAL_DEPTH = 3;
export const MAX_FINAL_MULTIPLIER = 3.0;

export function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    goalName: row.goal_name,
    level: row.level,
    parentGoalId: row.parent_goal_id ?? undefined,
    status: row.status,
    successCondition: row.success_condition ?? undefined,
    retrievalPolicyId: row.retrieval_policy_id ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    outcomeScore: row.outcome_score ?? undefined,
  };
}
