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

export function pushGoal(hippoRoot: string, opts: PushGoalOpts): Goal {
  const db = openHippoDb(hippoRoot);
  try {
    return pushGoalWithDb(db, opts);
  } finally {
    closeHippoDb(db);
  }
}

export function pushGoalWithDb(db: DatabaseSyncLike, opts: PushGoalOpts): Goal {
  const id = `g_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const createdAt = new Date().toISOString();
  let policyId: string | null = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    // Depth cap: count active for (tenant, session); suspend oldest if at cap.
    const activeCount = (db.prepare(`
      SELECT COUNT(*) AS c
      FROM goal_stack
      WHERE tenant_id = ? AND session_id = ? AND status = 'active'
    `).get(opts.tenantId, opts.sessionId) as { c: number }).c;

    if (activeCount >= MAX_ACTIVE_GOAL_DEPTH) {
      const overflow = activeCount - MAX_ACTIVE_GOAL_DEPTH + 1;
      db.prepare(`
        UPDATE goal_stack
        SET status = 'suspended'
        WHERE id IN (
          SELECT id FROM goal_stack
          WHERE tenant_id = ? AND session_id = ? AND status = 'active'
          ORDER BY created_at ASC
          LIMIT ?
        )
      `).run(opts.tenantId, opts.sessionId, overflow);
    }

    // Parent goal_stack row first (FK target).
    db.prepare(`
      INSERT INTO goal_stack
        (id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
         success_condition, retrieval_policy_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)
    `).run(
      id, opts.sessionId, opts.tenantId, opts.goalName,
      opts.level ?? 0, opts.parentGoalId ?? null,
      opts.successCondition ?? null, createdAt,
    );

    // Optional policy row, then point goal_stack.retrieval_policy_id at it.
    if (opts.policy) {
      policyId = `rp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      db.prepare(`
        INSERT INTO retrieval_policy
          (id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        policyId, id, opts.policy.policyType,
        opts.policy.weightSchemaFit ?? 1.0,
        opts.policy.weightRecency ?? 1.0,
        opts.policy.weightOutcome ?? 1.0,
        opts.policy.errorPriority ?? 1.0,
      );
      db.prepare(`UPDATE goal_stack SET retrieval_policy_id = ? WHERE id = ?`).run(policyId, id);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    id,
    sessionId: opts.sessionId,
    tenantId: opts.tenantId,
    goalName: opts.goalName,
    level: opts.level ?? 0,
    parentGoalId: opts.parentGoalId,
    status: 'active',
    successCondition: opts.successCondition,
    retrievalPolicyId: policyId ?? undefined,
    createdAt,
  };
}

export interface GetActiveGoalsOpts {
  sessionId: string;
  tenantId: string;
}

export function getActiveGoals(hippoRoot: string, opts: GetActiveGoalsOpts): Goal[] {
  const db = openHippoDb(hippoRoot);
  try {
    return getActiveGoalsWithDb(db, opts);
  } finally {
    closeHippoDb(db);
  }
}

export function getActiveGoalsWithDb(db: DatabaseSyncLike, opts: GetActiveGoalsOpts): Goal[] {
  const rows = db.prepare(`
    SELECT id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
           success_condition, retrieval_policy_id, created_at, completed_at, outcome_score
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ? AND status = 'active'
    ORDER BY created_at ASC
  `).all(opts.tenantId, opts.sessionId) as GoalRow[];
  return rows.map(rowToGoal);
}
