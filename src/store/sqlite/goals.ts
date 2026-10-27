// hippo.db's Goals group: the goal stack's writes and the every-status listing.
import { refuseSecretKeys } from '../../base/records/secret-keys.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { redactSecretsStrict, storedOrNull } from '../../base/util/secret-detect.js';
import type {
  ActiveGoals,
  Goal,
  GoalStatus,
  RetrievalPolicy,
  GetActiveGoalsOptions,
} from '../../base/ports/store/types.js';
import type { GoalRecallLogRow } from '../../base/ports/store/recall-writes.js';
import {
  DEFAULT_GOAL_LEVEL,
  type CompleteGoalOptions,
  type PushGoalOptions,
  type Goals,
} from '../../base/ports/store/goals.js';
import type { OnHandle } from './open.js';
import { bound, type Bodies } from './bound.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { generateId } from '../../base/memory/entry.js';
import { handleStamp } from './handle-clock.js';

// The goal stack's rules: its ids, its depth cap, the parent check, a new goal and policy, and
// the strength a completed goal passes to the memories recalled under it.

// The CLI prints these ids and the sequential-learning adapter reads them back as 16 hex
// characters.
const GOAL_ID_CHARS = 16;
const MAX_ACTIVE_GOAL_DEPTH = 3;
const POSITIVE_OUTCOME_THRESHOLD = 0.7;
const NEGATIVE_OUTCOME_THRESHOLD = 0.3;
const STRENGTH_BOOST = 1.1;
const STRENGTH_DECAY = 0.85;

const newGoalId = (): string => generateId('g', GOAL_ID_CHARS);

/** How many of a session's oldest active goals give way so one more fits under the depth cap. */
const goalOverflow = (activeCount: number): number =>
  Math.max(0, activeCount - MAX_ACTIVE_GOAL_DEPTH + 1);

/** Throws unless the push names no parent or one of its own tenant and session. */
function assertParentInSession(
  opts: PushGoalOptions,
  parent: { readonly tenantId: string; readonly sessionId: string } | undefined,
): void {
  if (!opts.parentGoalId) return;
  if (!parent) throw new Error(`parent goal not found: ${opts.parentGoalId}`);
  if (parent.tenantId !== opts.tenantId || parent.sessionId !== opts.sessionId) {
    throw new Error(`parent goal ${opts.parentGoalId} belongs to a different (tenant, session)`);
  }
}

/** The policy row a push with `policy` stores, each weight 1 unless given. */
function retrievalPolicyOf(
  goalId: string,
  policy: NonNullable<PushGoalOptions['policy']>,
): RetrievalPolicy {
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
function pushedGoal(
  id: string,
  opts: PushGoalOptions,
  createdAt: string,
  policyId: string | undefined,
): Goal {
  return {
    id,
    sessionId: opts.sessionId,
    tenantId: opts.tenantId,
    goalName: opts.goalName,
    level: opts.level ?? DEFAULT_GOAL_LEVEL,
    parentGoalId: opts.parentGoalId,
    status: 'active',
    successCondition: opts.successCondition,
    retrievalPolicyId: policyId,
    createdAt,
  };
}

/** The factor a completed goal's score applies to the strength of each memory recalled in its
 * active life. */
function goalOutcomeMultiplier(score: number): number {
  if (score >= POSITIVE_OUTCOME_THRESHOLD) return STRENGTH_BOOST;
  return score < NEGATIVE_OUTCOME_THRESHOLD ? STRENGTH_DECAY : 1;
}

const INSERT_GOAL_SQL = `
  INSERT INTO goal_stack
    (id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
     success_condition, retrieval_policy_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?)
`;

// SAFETY: every read cast to this row selects GOAL_COLUMNS; scripts/check-row-casts.mjs proves it.
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
const GOAL_COLUMNS = `id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
           success_condition, retrieval_policy_id, created_at, completed_at, outcome_score`;

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

/** Depth-cap enforcer for pushGoal and resumeGoal: suspends the oldest `overflow` goals;
 * **caller MUST be inside a `BEGIN IMMEDIATE` transaction**. @internal Internal goal-stack
 * invariant. Subject to change. */
function enforceDepthCapWithinTx(db: DatabaseSyncLike, tenantId: string, sessionId: string): void {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const activeCount = (
    cachedStatement(
      db,
      `
    SELECT COUNT(*) AS c
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ? AND status = 'active'
  `,
    ).get(tenantId, sessionId) as { c: number }
  ).c;

  const overflow = goalOverflow(activeCount);
  if (overflow > 0) {
    cachedStatement(
      db,
      `
      UPDATE goal_stack
      SET status = 'suspended'
      WHERE id IN (
        SELECT id FROM goal_stack
        WHERE tenant_id = ? AND session_id = ? AND status = 'active'
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      )
    `,
    ).run(tenantId, sessionId, overflow);
  }
}

function pushGoal(
  db: DatabaseSyncLike,
  tenantId: string,
  goal: Omit<PushGoalOptions, 'tenantId'>,
): Goal {
  const opts: PushGoalOptions = { ...goal, tenantId };
  refuseSecretKeys({ sessionId: opts.sessionId, parentGoalId: opts.parentGoalId });
  const id = newGoalId();
  const createdAt = handleStamp(db);
  const policy = opts.policy ? retrievalPolicyOf(id, opts.policy) : undefined;

  withWriteScope(db, 'push_goal', () => {
    // Depth cap: count active for (tenant, session); suspend oldest if at cap.
    enforceDepthCapWithinTx(db, opts.tenantId, opts.sessionId);
    assertParentInSession(opts, opts.parentGoalId ? parentOf(db, opts.parentGoalId) : undefined);

    // Parent goal_stack row first (FK target).
    cachedStatement(db, INSERT_GOAL_SQL).run(
      id,
      opts.sessionId,
      opts.tenantId,
      redactSecretsStrict(opts.goalName),
      opts.level ?? DEFAULT_GOAL_LEVEL,
      opts.parentGoalId ?? null,
      storedOrNull(opts.successCondition),
      createdAt,
    );
    if (policy) insertRetrievalPolicy(db, policy);
  });
  return pushedGoal(id, opts, createdAt, policy?.id);
}

function parentOf(db: DatabaseSyncLike, parentGoalId: string) {
  const parent = cachedStatement(
    db,
    `SELECT tenant_id, session_id FROM goal_stack WHERE id = ?`,
  ).get(parentGoalId) as { tenant_id: string; session_id: string } | undefined;
  return parent && { tenantId: parent.tenant_id, sessionId: parent.session_id };
}

/** Insert the policy row, then point goal_stack.retrieval_policy_id at it. */
function insertRetrievalPolicy(db: DatabaseSyncLike, policy: RetrievalPolicy): void {
  cachedStatement(
    db,
    `
    INSERT INTO retrieval_policy
      (id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    policy.id,
    policy.goalId,
    policy.policyType,
    policy.weightSchemaFit,
    policy.weightRecency,
    policy.weightOutcome,
    policy.errorPriority,
  );
  cachedStatement(db, `UPDATE goal_stack SET retrieval_policy_id = ? WHERE id = ?`).run(
    policy.id,
    policy.goalId,
  );
}

/** The active goals and their policies on one handle, so a goal and its policy never disagree. */
export function activeGoalsWithPolicies(
  db: DatabaseSyncLike,
  opts: GetActiveGoalsOptions,
): ActiveGoals {
  const goals = listActiveGoalsOn(db, opts);
  return { goals, policies: readGoalPolicies(db, goals) };
}

/** Every goal of a (tenant, session), whatever its status, oldest first. */
function listSessionGoals(db: DatabaseSyncLike, tenantId: string, sessionId: string): Goal[] {
  const rows = cachedStatement(
    db,
    `
    SELECT ${GOAL_COLUMNS}
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ?
    ORDER BY created_at ASC, rowid ASC
  `,
  ).all(tenantId, sessionId) as GoalRow[];
  return rows.map(rowToGoal);
}

function listActiveGoalsOn(db: DatabaseSyncLike, opts: GetActiveGoalsOptions): Goal[] {
  const rows = cachedStatement(
    db,
    `
    SELECT ${GOAL_COLUMNS}
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ? AND status = 'active'
    ORDER BY created_at ASC, rowid ASC
  `,
  ).all(opts.tenantId, opts.sessionId) as GoalRow[];
  return rows.map(rowToGoal);
}

// Per-goal retrieval_policy multipliers compose onto the base goal-tag boost and are hard-capped at
// MAX_FINAL_MULTIPLIER (3.0x) before scoring.
function readGoalPolicies(
  db: DatabaseSyncLike,
  active: readonly Goal[],
): Map<string, RetrievalPolicy> {
  const policiesByGoalId = new Map<string, RetrievalPolicy>();
  const policyIds = [
    ...new Set(active.flatMap((g) => (g.retrievalPolicyId ? [g.retrievalPolicyId] : []))),
  ];
  if (policyIds.length === 0) return policiesByGoalId;
  // SAFETY: the goal stack's depth cap bounds the IN list.
  const rows = cachedStatement(
    db,
    `
    SELECT id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority
    FROM retrieval_policy WHERE id IN (SELECT value FROM json_each(?))
  `,
  ).all(JSON.stringify(policyIds)) as Array<{
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
export function localGoalRecallRows(
  db: DatabaseSyncLike,
  rows: readonly GoalRecallLogRow[],
): GoalRecallLogRow[] {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.memoryId))];
  const local = cachedStatement(
    db,
    `SELECT id FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
  ).all(JSON.stringify(ids)) as Array<{
    id: string;
  }>;
  const localIds = new Set(local.map((r) => r.id));
  return rows.filter((r) => localIds.has(r.memoryId));
}

/** INSERT OR IGNORE: UNIQUE(memory_id, goal_id) makes a re-recall during the same goal life a
 * no-op for outcome attribution. */
export function writeGoalRecallLog(db: DatabaseSyncLike, rows: readonly GoalRecallLogRow[]): void {
  if (rows.length === 0) return;
  const insertLog = cachedStatement(
    db,
    `
    INSERT OR IGNORE INTO goal_recall_log
      (goal_id, memory_id, tenant_id, session_id, recalled_at, score)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  );
  for (const row of rows) {
    insertLog.run(row.goalId, row.memoryId, row.tenantId, row.sessionId, row.recalledAt, row.score);
  }
}

function completeGoal(
  db: DatabaseSyncLike,
  tenantId: string,
  goalId: string,
  opts: CompleteGoalOptions,
): void {
  const completedAt = handleStamp(db);
  const score = opts.outcomeScore ?? null;

  withWriteScope(db, 'complete_goal', () => {
    const goalRow = cachedStatement(
      db,
      `SELECT created_at, status FROM goal_stack WHERE id = ? AND tenant_id = ?`,
    ).get(goalId, tenantId) as { created_at: string; status: string } | undefined;
    if (!goalRow) return;
    if (goalRow.status === 'completed') {
      // Already completed -- second call is a no-op for idempotency.
      return;
    }

    cachedStatement(
      db,
      `
      UPDATE goal_stack
      SET status = 'completed', completed_at = ?, outcome_score = ?
      WHERE id = ? AND tenant_id = ?
    `,
    ).run(completedAt, score, goalId, tenantId);

    if (score !== null && !opts.noPropagate) {
      const multiplier = goalOutcomeMultiplier(score);

      if (multiplier !== 1) {
        const since = goalRow.created_at;
        scaleGoalRecalls(db, { tenantId, goalId, multiplier, since, until: completedAt });
      }
    }
  });
}

/** A completed goal, its outcome multiplier and the start and end of its active life. */
interface ScaleGoalRecallsOptions {
  readonly tenantId: string;
  readonly goalId: string;
  readonly multiplier: number;
  readonly since: string;
  readonly until: string;
}

// Lifespan window: only recalls during this goal's active life; UNIQUE(memory_id, goal_id) gives
// one adjustment per pair.
function scaleGoalRecalls(
  db: DatabaseSyncLike,
  { tenantId, goalId, multiplier, since, until }: ScaleGoalRecallsOptions,
): void {
  cachedStatement(
    db,
    `
          UPDATE memories
          SET strength = MIN(1.0, MAX(0.0, strength * ?))
          WHERE tenant_id = ? AND id IN (
            SELECT memory_id FROM goal_recall_log
            WHERE goal_id = ?
              AND recalled_at >= ?
              AND recalled_at <= ?
          )
        `,
  ).run(multiplier, tenantId, goalId, since, until);
}

function suspendGoal(db: DatabaseSyncLike, tenantId: string, goalId: string): void {
  cachedStatement(
    db,
    `UPDATE goal_stack SET status = 'suspended' WHERE id = ? AND tenant_id = ? AND status = 'active'`,
  ).run(goalId, tenantId);
}

function resumeGoal(db: DatabaseSyncLike, tenantId: string, goalId: string): void {
  withWriteScope(db, 'resume_goal', () => {
    const row = cachedStatement(
      db,
      `SELECT session_id, status FROM goal_stack WHERE id = ? AND tenant_id = ?`,
    ).get(goalId, tenantId) as { session_id: string; status: string } | undefined;
    if (!row || row.status !== 'suspended') return;

    enforceDepthCapWithinTx(db, tenantId, row.session_id);

    cachedStatement(
      db,
      `UPDATE goal_stack SET status = 'active' WHERE id = ? AND tenant_id = ?`,
    ).run(goalId, tenantId);
  });
}

const goalsBodies: Bodies<Goals> = {
  push: pushGoal,
  sessionGoals: listSessionGoals,
  complete: completeGoal,
  suspend: suspendGoal,
  resume: resumeGoal,
};

export function sqliteGoals(on: OnHandle): Goals {
  return bound(on, goalsBodies);
}
