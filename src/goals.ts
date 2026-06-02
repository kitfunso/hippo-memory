// src/goals.ts
import { randomUUID } from 'node:crypto';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';
import type { MemoryEntry } from './memory.js';
import type { RerankStep } from './search.js';

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

/**
 * v1.7.4 — depth-cap enforcer extracted from pushGoalWithDb and resumeGoal.
 * If the (tenant, session) has >= MAX_ACTIVE_GOAL_DEPTH active goals,
 * suspend the oldest `overflow` ones.
 *
 * **Precondition: caller MUST already be inside a `BEGIN IMMEDIATE`
 * transaction.** Helper does not open or commit -- name reflects this so it
 * is impossible to misread the contract at a call site. Both existing call
 * sites (pushGoalWithDb, resumeGoal) wrap in `BEGIN IMMEDIATE` already.
 *
 * @internal v1.7.4 -- internal goal-stack invariant. Subject to change.
 */
export function enforceDepthCapWithinTx(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
): void {
  const activeCount = (db.prepare(`
    SELECT COUNT(*) AS c
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ? AND status = 'active'
  `).get(tenantId, sessionId) as { c: number }).c;

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

export function pushGoalWithDb(db: DatabaseSyncLike, opts: PushGoalOpts): Goal {
  const id = `g_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const createdAt = new Date().toISOString();
  let policyId: string | null = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    // Depth cap: count active for (tenant, session); suspend oldest if at cap.
    enforceDepthCapWithinTx(db, opts.tenantId, opts.sessionId);

    if (opts.parentGoalId) {
      const parent = db.prepare(
        `SELECT tenant_id, session_id FROM goal_stack WHERE id = ?`,
      ).get(opts.parentGoalId) as { tenant_id: string; session_id: string } | undefined;
      if (!parent) {
        throw new Error(`parent goal not found: ${opts.parentGoalId}`);
      }
      if (parent.tenant_id !== opts.tenantId || parent.session_id !== opts.sessionId) {
        throw new Error(
          `parent goal ${opts.parentGoalId} belongs to a different (tenant, session)`,
        );
      }
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

/**
 * v1.7.4 -- dlPFC goal-stack boost helper. Applies the multi-goal boost to a
 * list of entry-backed scored rows when (tenant, session) has active goals.
 * Pre-v1.7.4 this logic lived inline in cmdRecall (src/cli.ts:988-1140);
 * lifting here lets api.recall (primary band only) AND MCP physics/hybrid
 * call it.
 *
 * Caller responsibilities:
 *   - Do NOT call when an explicit `goalTag` is set (caller's gate)
 *   - Pass entry-backed rows (with `entry.tags`, `entry.id`, optional
 *     `entry.schema_fit`)
 *   - Manage the db handle lifecycle (helper neither opens nor closes)
 *   - Recompute `tokens` after if returned rows are projected to a budgeted
 *     shape
 *
 * Side effects:
 *   - INSERT OR IGNORE into `goal_recall_log` for each (boosted, goal) pair
 *   - Local memory id filter applied before INSERT (skips global-only ids
 *     to preserve FK invariant on goal_recall_log.memory_id)
 *
 * @internal v1.7.4 -- internal recall ranking helper. Subject to change.
 */
export function applyGoalStackBoost<R extends { entry: MemoryEntry; score: number }>(
  db: DatabaseSyncLike,
  results: R[],
  opts: {
    sessionId: string;
    tenantId: string;
    limit: number;
    /**
     * A7 recall-trace (optional side-channel). When supplied, the helper
     * records one goal-boost `RerankStep` per ACTUALLY-boosted row, keyed by
     * `entry.id`. This is a SEPARATE accumulator, NOT a field on the result
     * row — the helper re-spreads rows and strips internal markers
     * (`_goalMatches` below), so a row field would be dropped. The score-mul
     * + re-sort math is untouched; the trace is only populated when this map
     * is passed (default path never allocates → byte-identical).
     */
    trace?: Map<string, RerankStep>;
  },
): R[] {
  const { sessionId, tenantId, limit, trace } = opts;
  const active = getActiveGoalsWithDb(db, { sessionId, tenantId });
  if (active.length === 0) return results;

  const goalsByTag = new Map(active.map((g) => [g.goalName, g]));

  // Load retrieval_policy rows for active goals so per-policy multipliers
  // can compose onto the base goal-tag boost. Composed result is hard-capped
  // at MAX_FINAL_MULTIPLIER (3.0x) BEFORE applying to score -- even an
  // `errorPriority: 9.0` policy cannot exceed 3.0x.
  const policiesByGoalId = new Map<string, RetrievalPolicy>();
  for (const g of active) {
    if (!g.retrievalPolicyId) continue;
    const row = db.prepare(`
      SELECT id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority
      FROM retrieval_policy WHERE id = ?
    `).get(g.retrievalPolicyId) as {
      id: string;
      goal_id: string;
      policy_type: RetrievalPolicy['policyType'];
      weight_schema_fit: number;
      weight_recency: number;
      weight_outcome: number;
      error_priority: number;
    } | undefined;
    if (row) {
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
  }

  let boosted = results
    .map((r) => {
      const tags = r.entry.tags ?? [];
      const matches = tags.filter((t) => goalsByTag.has(t));
      if (matches.length === 0) return r;
      // Base 2.0x for first match, +0.5x per additional, capped at 3.0x.
      let multiplier = Math.min(
        2.0 + 0.5 * (matches.length - 1),
        MAX_FINAL_MULTIPLIER,
      );
      // Compose per-policy multipliers per matched tag.
      for (const tag of matches) {
        const goal = goalsByTag.get(tag)!;
        const policy = policiesByGoalId.get(goal.id);
        if (!policy) continue;
        if (policy.policyType === 'error-prioritized' && tags.includes('error')) {
          multiplier *= policy.errorPriority;
        } else if (policy.policyType === 'schema-fit-biased') {
          // Linearly weight schema_fit in [0,1] up to (weightSchemaFit)x.
          // Default 1.0 is a no-op.
          multiplier *=
            1.0 +
            Math.max(0, policy.weightSchemaFit - 1.0) *
              (r.entry.schema_fit ?? 0.5);
        } else if (policy.policyType === 'recency-first') {
          multiplier *= policy.weightRecency;
        } else if (policy.policyType === 'hybrid') {
          multiplier *= policy.weightOutcome;
        }
      }
      // Hard cap AFTER all composition.
      multiplier = Math.min(multiplier, MAX_FINAL_MULTIPLIER);
      // A7 recall-trace side-channel: record the goal-boost step BEFORE the
      // score is mutated, keyed by entry id. Pure read of r.score here; the
      // mutation below is byte-identical to pre-A7.
      if (trace) {
        trace.set(r.entry.id, {
          stage: 'goal-boost',
          multiplier,
          scoreBefore: r.score,
          scoreAfter: r.score * multiplier,
          note: matches.join(', '),
        });
      }
      return {
        ...r,
        score: r.score * multiplier,
        _goalMatches: matches,
      } as R & { _goalMatches: string[] };
    })
    .sort((a, b) => b.score - a.score) as R[];

  // Filter to local memories only -- global memory IDs aren't in this DB's
  // memories table, so the FK on goal_recall_log.memory_id would fail.
  // dlPFC depth's outcome propagation is session-scoped to local; boost on
  // ranking still applies to global results, just no log row -> no
  // propagation.
  const topKIds = boosted.slice(0, limit).map((r) => r.entry.id);
  const localIds = new Set<string>();
  if (topKIds.length > 0) {
    const placeholders = topKIds.map(() => '?').join(',');
    const localRows = db.prepare(
      `SELECT id FROM memories WHERE id IN (${placeholders})`,
    ).all(...topKIds) as Array<{ id: string }>;
    for (const row of localRows) localIds.add(row.id);
  }

  // Log top-K boosted recalls. INSERT OR IGNORE because
  // UNIQUE(memory_id, goal_id) means a re-recall during the same goal life
  // is a no-op for outcome attribution.
  const recalledAt = new Date().toISOString();
  const insertLog = db.prepare(`
    INSERT OR IGNORE INTO goal_recall_log
      (goal_id, memory_id, tenant_id, session_id, recalled_at, score)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const r of boosted.slice(0, limit)) {
    if (!localIds.has(r.entry.id)) continue; // global -> skip log insert
    const matches = (r as R & { _goalMatches?: string[] })._goalMatches;
    if (!matches || matches.length === 0) continue;
    for (const tag of matches) {
      const goal = goalsByTag.get(tag);
      if (!goal) continue;
      insertLog.run(
        goal.id,
        r.entry.id,
        tenantId,
        sessionId,
        recalledAt,
        r.score,
      );
    }
  }

  // Strip the internal _goalMatches marker so callers don't see it.
  return boosted.map((r) => {
    const { _goalMatches: _omit, ...rest } = r as R & { _goalMatches?: string[] };
    return rest as R;
  });
}

const POSITIVE_OUTCOME_THRESHOLD = 0.7;
const NEGATIVE_OUTCOME_THRESHOLD = 0.3;
const STRENGTH_BOOST = 1.10;
const STRENGTH_DECAY = 0.85;

export interface CompleteGoalOpts {
  outcomeScore?: number;
  /**
   * v1.7.4 — when true, skip the strength-multiplier propagation block.
   * Default false (propagate). The goal's status still transitions to
   * 'completed' and `outcome_score` is still recorded; only the side-effect
   * on recalled memories' strength is suppressed.
   *
   * Note: the status-check idempotency guard short-circuits a second
   * `completeGoal` call BEFORE this flag is read, so a noPropagate=true
   * second call after a propagating first call is a true no-op (propagation
   * already happened on call 1; call 2 returns early regardless).
   */
  noPropagate?: boolean;
}

export function completeGoal(hippoRoot: string, goalId: string, opts: CompleteGoalOpts): void {
  const db = openHippoDb(hippoRoot);
  try {
    const completedAt = new Date().toISOString();
    const score = opts.outcomeScore ?? null;

    db.exec('BEGIN IMMEDIATE');
    try {
      const goalRow = db.prepare(
        `SELECT created_at, status FROM goal_stack WHERE id = ?`,
      ).get(goalId) as { created_at: string; status: string } | undefined;
      if (!goalRow) {
        db.exec('COMMIT');
        return;
      }
      if (goalRow.status === 'completed') {
        // Already completed -- second call is a no-op for idempotency.
        db.exec('COMMIT');
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
          // Lifespan window: only memories whose recall happened during this
          // goal's active life. UNIQUE(memory_id, goal_id) guarantees one
          // adjustment per (memory, goal) pair.
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

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    closeHippoDb(db);
  }
}

export function suspendGoal(hippoRoot: string, goalId: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(`UPDATE goal_stack SET status = 'suspended' WHERE id = ? AND status = 'active'`).run(goalId);
  } finally {
    closeHippoDb(db);
  }
}

export function resumeGoal(hippoRoot: string, goalId: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(
        `SELECT session_id, tenant_id, status FROM goal_stack WHERE id = ?`,
      ).get(goalId) as { session_id: string; tenant_id: string; status: string } | undefined;
      if (!row || row.status !== 'suspended') {
        db.exec('COMMIT');
        return;
      }

      enforceDepthCapWithinTx(db, row.tenant_id, row.session_id);

      db.prepare(`UPDATE goal_stack SET status = 'active' WHERE id = ?`).run(goalId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    closeHippoDb(db);
  }
}
