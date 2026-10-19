// hippo.db's Goals group: the goal stack's writes and the every-status listing.
import { generateId } from '../../core/memory.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { placeholders } from '../../util/sql.js';
import type { ActiveGoals, Goal, GoalStatus, RetrievalPolicy, GetActiveGoalsOpts } from '../port/types.js';
import type { GoalRecallLogRow } from '../port/recall-writes.js';
import type { CompleteGoalOpts, PushGoalOpts } from '../port/goals.js';
import type { Goals } from '../port-groups.js';
import type { Sync } from './served.js';
import type { OnHandle } from './open.js';
import { bound, type Bodies } from './bound.js';

// The CLI prints these ids and the sequential-learning adapter reads them back as 16 hex characters.
const GOAL_ID_CHARS = 16;

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

const MAX_ACTIVE_GOAL_DEPTH = 3;

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

/** Depth-cap enforcer for pushGoalAt and resumeGoalAt: suspends the oldest `overflow` goals; **caller MUST be inside
 * a `BEGIN IMMEDIATE` transaction**. @internal Internal goal-stack invariant. Subject to change. */
function enforceDepthCapWithinTx(db: DatabaseSyncLike, tenantId: string, sessionId: string): void {
  // SAFETY: the row comes from the SELECT above, which projects exactly one
  // column, `c`, as a COUNT(*).
  const activeCount = (
    db
      .prepare(`
    SELECT COUNT(*) AS c
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ? AND status = 'active'
  `)
      .get(tenantId, sessionId) as { c: number }
  ).c;

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
    `).run(tenantId, sessionId, overflow);
  }
}

function pushGoalAt(db: DatabaseSyncLike, tenantId: string, goal: Omit<PushGoalOpts, 'tenantId'>): Goal {
  const opts: PushGoalOpts = { ...goal, tenantId };
  const id = generateId('g', GOAL_ID_CHARS);
  const createdAt = new Date().toISOString();
  let policyId: string | null = null;

  withWriteScope(db, 'push_goal', () => {
    // Depth cap: count active for (tenant, session); suspend oldest if at cap.
    enforceDepthCapWithinTx(db, opts.tenantId, opts.sessionId);

    assertParentInSession(db, opts);

    // Parent goal_stack row first (FK target).
    db.prepare(`
      INSERT INTO goal_stack
        (id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
         success_condition, retrieval_policy_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)
    `).run(
      id,
      opts.sessionId,
      opts.tenantId,
      opts.goalName,
      opts.level ?? 0,
      opts.parentGoalId ?? null,
      opts.successCondition ?? null,
      createdAt,
    );

    // Optional policy row, then point goal_stack.retrieval_policy_id at it.
    if (opts.policy) {
      policyId = insertRetrievalPolicy(db, id, opts.policy);
    }
  });

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

function assertParentInSession(db: DatabaseSyncLike, opts: PushGoalOpts): void {
  if (!opts.parentGoalId) return;
  // SAFETY: the row comes from the SELECT above, which projects exactly
  // the tenant_id and session_id columns of goal_stack.
  const parent = db.prepare(`SELECT tenant_id, session_id FROM goal_stack WHERE id = ?`).get(opts.parentGoalId) as
    | { tenant_id: string; session_id: string }
    | undefined;
  if (!parent) {
    throw new Error(`parent goal not found: ${opts.parentGoalId}`);
  }
  if (parent.tenant_id !== opts.tenantId || parent.session_id !== opts.sessionId) {
    throw new Error(`parent goal ${opts.parentGoalId} belongs to a different (tenant, session)`);
  }
}

/** Insert the policy row, then point goal_stack.retrieval_policy_id at it; returns the new policy id. */
function insertRetrievalPolicy(
  db: DatabaseSyncLike,
  goalId: string,
  policy: NonNullable<PushGoalOpts['policy']>,
): string {
  const policyId = generateId('rp', GOAL_ID_CHARS);
  db.prepare(`
    INSERT INTO retrieval_policy
      (id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    policyId,
    goalId,
    policy.policyType,
    policy.weightSchemaFit ?? 1.0,
    policy.weightRecency ?? 1.0,
    policy.weightOutcome ?? 1.0,
    policy.errorPriority ?? 1.0,
  );
  db.prepare(`UPDATE goal_stack SET retrieval_policy_id = ? WHERE id = ?`).run(policyId, goalId);
  return policyId;
}

/** The active goals and their policies on one handle, so a goal and its policy never disagree. */
export function activeGoalsWithPoliciesAt(db: DatabaseSyncLike, opts: GetActiveGoalsOpts): ActiveGoals {
  const goals = getActiveGoalsWithDb(db, opts);
  return { goals, policies: loadGoalPolicies(db, goals) };
}

/** Every goal of a (tenant, session), whatever its status, oldest first. */
function getSessionGoalsAt(db: DatabaseSyncLike, tenantId: string, sessionId: string): Goal[] {
  // SAFETY: rows come from the SELECT below, which projects exactly GoalRow's columns.
  const rows = db
    .prepare(`
    SELECT id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
           success_condition, retrieval_policy_id, created_at, completed_at, outcome_score
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ?
    ORDER BY created_at ASC
  `)
    .all(tenantId, sessionId) as GoalRow[];
  return rows.map(rowToGoal);
}

function getActiveGoalsWithDb(db: DatabaseSyncLike, opts: GetActiveGoalsOpts): Goal[] {
  // SAFETY: rows come from the SELECT above, which projects exactly
  // GoalRow's columns (in the same order goal_stack defines them).
  const rows = db
    .prepare(`
    SELECT id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
           success_condition, retrieval_policy_id, created_at, completed_at, outcome_score
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ? AND status = 'active'
    ORDER BY created_at ASC
  `)
    .all(opts.tenantId, opts.sessionId) as GoalRow[];
  return rows.map(rowToGoal);
}

// Per-goal retrieval_policy multipliers compose onto the base goal-tag boost and are hard-capped at
// MAX_FINAL_MULTIPLIER (3.0x) before scoring.
function loadGoalPolicies(db: DatabaseSyncLike, active: readonly Goal[]): Map<string, RetrievalPolicy> {
  const policiesByGoalId = new Map<string, RetrievalPolicy>();
  const policyIds = [...new Set(active.flatMap((g) => (g.retrievalPolicyId ? [g.retrievalPolicyId] : [])))];
  if (policyIds.length === 0) return policiesByGoalId;
  // SAFETY: the SELECT projects exactly these seven retrieval_policy columns; MAX_ACTIVE_GOAL_DEPTH bounds the IN list.
  const rows = db
    .prepare(`
    SELECT id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority
    FROM retrieval_policy WHERE id IN (${placeholders(policyIds.length)})
  `)
    .all(...policyIds) as Array<{
    id: string;
    goal_id: string;
    policy_type: RetrievalPolicy['policyType'];
    weight_schema_fit: number;
    weight_recency: number;
    weight_outcome: number;
    error_priority: number;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const g of active) {
    const row = g.retrievalPolicyId ? byId.get(g.retrievalPolicyId) : undefined;
    if (!row) continue;
    policiesByGoalId.set(g.id, {
      id: row.id,
      goalId: row.goal_id,
      policyType: row.policy_type,
      weightSchemaFit: row.weight_schema_fit,
      weightRecency: row.weight_recency,
      weightOutcome: row.weight_outcome,
      errorPriority: row.error_priority,
    });
  }
  return policiesByGoalId;
}

/** The rows whose memory lives in this store: goal_recall_log.memory_id references memories, so a global row would fail
 *  the insert. A global result keeps its boost; it only earns no log row, so no outcome propagation. */
export function localGoalRecallRows(db: DatabaseSyncLike, rows: readonly GoalRecallLogRow[]): GoalRecallLogRow[] {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.memoryId))];
  // SAFETY: the SELECT projects exactly one column, `id`, from memories.
  const local = db.prepare(`SELECT id FROM memories WHERE id IN (${placeholders(ids.length)})`).all(...ids) as Array<{
    id: string;
  }>;
  const localIds = new Set(local.map((r) => r.id));
  return rows.filter((r) => localIds.has(r.memoryId));
}

/** INSERT OR IGNORE: UNIQUE(memory_id, goal_id) makes a re-recall during the same goal life a no-op for outcome
 * attribution. */
export function writeGoalRecallLog(db: DatabaseSyncLike, rows: readonly GoalRecallLogRow[]): void {
  if (rows.length === 0) return;
  const insertLog = db.prepare(`
    INSERT OR IGNORE INTO goal_recall_log
      (goal_id, memory_id, tenant_id, session_id, recalled_at, score)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insertLog.run(row.goalId, row.memoryId, row.tenantId, row.sessionId, row.recalledAt, row.score);
  }
}

const POSITIVE_OUTCOME_THRESHOLD = 0.7;
const NEGATIVE_OUTCOME_THRESHOLD = 0.3;
const STRENGTH_BOOST = 1.1;
const STRENGTH_DECAY = 0.85;

function completeGoalAt(db: DatabaseSyncLike, _tenantId: string, goalId: string, opts: CompleteGoalOpts): void {
  const completedAt = new Date().toISOString();
  const score = opts.outcomeScore ?? null;

  withWriteScope(db, 'complete_goal', () => {
    // SAFETY: the row comes from the SELECT above, which projects exactly
    // the created_at and status columns of goal_stack.
    const goalRow = db.prepare(`SELECT created_at, status FROM goal_stack WHERE id = ?`).get(goalId) as
      | { created_at: string; status: string }
      | undefined;
    if (!goalRow) return;
    if (goalRow.status === 'completed') {
      // Already completed -- second call is a no-op for idempotency.
      return;
    }

    db.prepare(`
      UPDATE goal_stack
      SET status = 'completed', completed_at = ?, outcome_score = ?
      WHERE id = ?
    `).run(completedAt, score, goalId);

    if (score !== null && !opts.noPropagate) {
      let multiplier = 1;
      if (score >= POSITIVE_OUTCOME_THRESHOLD) multiplier = STRENGTH_BOOST;
      else if (score < NEGATIVE_OUTCOME_THRESHOLD) multiplier = STRENGTH_DECAY;

      if (multiplier !== 1) {
        // Lifespan window: only recalls during this goal's active life; UNIQUE(memory_id, goal_id) gives one
        // adjustment per pair.
        db.prepare(`
          UPDATE memories
          SET strength = MIN(1.0, MAX(0.0, strength * ?))
          WHERE id IN (
            SELECT memory_id FROM goal_recall_log
            WHERE goal_id = ?
              AND recalled_at >= ?
              AND recalled_at <= ?
          )
        `).run(multiplier, goalId, goalRow.created_at, completedAt);
      }
    }
  });
}

function suspendGoalAt(db: DatabaseSyncLike, _tenantId: string, goalId: string): void {
  db.prepare(`UPDATE goal_stack SET status = 'suspended' WHERE id = ? AND status = 'active'`).run(goalId);
}

function resumeGoalAt(db: DatabaseSyncLike, _tenantId: string, goalId: string): void {
  withWriteScope(db, 'resume_goal', () => {
    // SAFETY: the row comes from the SELECT above, which projects exactly
    // the session_id, tenant_id, and status columns of goal_stack.
    const row = db.prepare(`SELECT session_id, tenant_id, status FROM goal_stack WHERE id = ?`).get(goalId) as
      | { session_id: string; tenant_id: string; status: string }
      | undefined;
    if (!row || row.status !== 'suspended') return;

    enforceDepthCapWithinTx(db, row.tenant_id, row.session_id);

    db.prepare(`UPDATE goal_stack SET status = 'active' WHERE id = ?`).run(goalId);
  });
}

// Goal ids are not tenant-scoped in hippo.db, so complete, suspend and resume ignore the tenant; the api checks the
// host admin.
const goalsAt: Bodies<Goals> = {
  push: pushGoalAt,
  sessionGoals: getSessionGoalsAt,
  complete: completeGoalAt,
  suspend: suspendGoalAt,
  resume: resumeGoalAt,
};

export function sqliteGoals(on: OnHandle): Sync<Goals> {
  return bound(on, goalsAt);
}
