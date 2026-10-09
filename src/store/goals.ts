// src/store/goals.ts
import { randomUUID } from 'node:crypto';
import { openHippoDb, closeHippoDb, withWriteScope, type DatabaseSyncLike } from '../db.js';
import { compareScoresDesc } from '../compare.js';
import type { MemoryEntry } from '../memory.js';
import type { RerankStep } from '../core/search-types.js';

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

const MAX_ACTIVE_GOAL_DEPTH = 3;
const MAX_FINAL_MULTIPLIER = 3.0;

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
 * Depth-cap enforcer shared by pushGoalWithDb and resumeGoal.
 * If the (tenant, session) has >= MAX_ACTIVE_GOAL_DEPTH active goals,
 * suspend the oldest `overflow` ones.
 *
 * **Precondition: caller MUST already be inside a `BEGIN IMMEDIATE`
 * transaction.** Helper does not open or commit -- name reflects this so it
 * is impossible to misread the contract at a call site. Both existing call
 * sites (pushGoalWithDb, resumeGoal) wrap in `BEGIN IMMEDIATE` already.
 *
 * @internal Internal goal-stack invariant. Subject to change.
 */
function enforceDepthCapWithinTx(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
): void {
  // SAFETY: the row comes from the SELECT above, which projects exactly one
  // column, `c`, as a COUNT(*).
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
      id, opts.sessionId, opts.tenantId, opts.goalName,
      opts.level ?? 0, opts.parentGoalId ?? null,
      opts.successCondition ?? null, createdAt,
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

/** Insert the policy row, then point goal_stack.retrieval_policy_id at it; returns the new policy id. */
function insertRetrievalPolicy(
  db: DatabaseSyncLike,
  goalId: string,
  policy: NonNullable<PushGoalOpts['policy']>,
): string {
  const policyId = `rp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  db.prepare(`
    INSERT INTO retrieval_policy
      (id, goal_id, policy_type, weight_schema_fit, weight_recency, weight_outcome, error_priority)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    policyId, goalId, policy.policyType,
    policy.weightSchemaFit ?? 1.0,
    policy.weightRecency ?? 1.0,
    policy.weightOutcome ?? 1.0,
    policy.errorPriority ?? 1.0,
  );
  db.prepare(`UPDATE goal_stack SET retrieval_policy_id = ? WHERE id = ?`).run(policyId, goalId);
  return policyId;
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

/** A session's active goals, oldest first, and the retrieval policy of each goal that names one. */
export interface ActiveGoals {
  readonly goals: Goal[];
  readonly policies: ReadonlyMap<string, RetrievalPolicy>;
}

/** The active goals and their policies on one handle, so a goal and its policy never disagree. */
export function activeGoalsWithPolicies(hippoRoot: string, opts: GetActiveGoalsOpts): ActiveGoals {
  const db = openHippoDb(hippoRoot);
  try {
    const goals = getActiveGoalsWithDb(db, opts);
    return { goals, policies: loadGoalPolicies(db, goals) };
  } finally {
    closeHippoDb(db);
  }
}

/** Every goal of a (tenant, session), whatever its status, oldest first. */
export function getSessionGoals(hippoRoot: string, opts: GetActiveGoalsOpts): Goal[] {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: rows come from the SELECT below, which projects exactly GoalRow's columns.
    const rows = db.prepare(`
      SELECT id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
             success_condition, retrieval_policy_id, created_at, completed_at, outcome_score
      FROM goal_stack
      WHERE tenant_id = ? AND session_id = ?
      ORDER BY created_at ASC
    `).all(opts.tenantId, opts.sessionId) as GoalRow[];
    return rows.map(rowToGoal);
  } finally {
    closeHippoDb(db);
  }
}

function getActiveGoalsWithDb(db: DatabaseSyncLike, opts: GetActiveGoalsOpts): Goal[] {
  // SAFETY: rows come from the SELECT above, which projects exactly
  // GoalRow's columns (in the same order goal_stack defines them).
  const rows = db.prepare(`
    SELECT id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
           success_condition, retrieval_policy_id, created_at, completed_at, outcome_score
    FROM goal_stack
    WHERE tenant_id = ? AND session_id = ? AND status = 'active'
    ORDER BY created_at ASC
  `).all(opts.tenantId, opts.sessionId) as GoalRow[];
  return rows.map(rowToGoal);
}

/** One `goal_recall_log` row: a boosted local memory recalled while its goal was active. */
export interface GoalRecallLogRow {
  goalId: string;
  memoryId: string;
  tenantId: string;
  sessionId: string;
  recalledAt: string;
  score: number;
}

/** Options of {@link boostByGoals}. */
export interface GoalStackBoostOpts {
  sessionId: string;
  tenantId: string;
  limit: number;
  /**
   * Optional side-channel: one goal-boost `RerankStep` per boosted row, keyed by
   * `entry.id`. A map rather than a row field because the helper re-spreads rows.
   * Only populated when passed, so the default path allocates nothing.
   */
  trace?: Map<string, RerankStep>;
}

/** The boosted, re-sorted rows and the `goal_recall_log` rows they earn. */
export interface GoalStackBoost<R> {
  results: R[];
  log: GoalRecallLogRow[];
}

// Load retrieval_policy rows for active goals so per-policy multipliers
// can compose onto the base goal-tag boost. Composed result is hard-capped
// at MAX_FINAL_MULTIPLIER (3.0x) BEFORE applying to score -- even an
// `errorPriority: 9.0` policy cannot exceed 3.0x.
function loadGoalPolicies(db: DatabaseSyncLike, active: readonly Goal[]): Map<string, RetrievalPolicy> {
  const policiesByGoalId = new Map<string, RetrievalPolicy>();
  for (const g of active) {
    if (!g.retrievalPolicyId) continue;
    // SAFETY: the row comes from the SELECT above, which projects exactly
    // these seven retrieval_policy columns.
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
  return policiesByGoalId;
}

/** The capped boost for one row whose tags match `matches` active goals. */
function goalBoostMultiplier(
  entry: MemoryEntry,
  tags: string[],
  matches: string[],
  goalsByTag: Map<string, Goal>,
  policiesByGoalId: ReadonlyMap<string, RetrievalPolicy>,
): number {
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
          (entry.schema_fit ?? 0.5);
    } else if (policy.policyType === 'recency-first') {
      multiplier *= policy.weightRecency;
    } else if (policy.policyType === 'hybrid') {
      multiplier *= policy.weightOutcome;
    }
  }
  // Hard cap AFTER all composition.
  return Math.min(multiplier, MAX_FINAL_MULTIPLIER);
}

/** Log rows for the top `limit` boosted rows, one per matched goal. */
function buildGoalRecallLog<R extends { entry: MemoryEntry; score: number }>(
  boosted: R[],
  matchesByEntryId: Map<string, string[]>,
  goalsByTag: Map<string, Goal>,
  opts: GoalStackBoostOpts,
): GoalRecallLogRow[] {
  const { sessionId, tenantId, limit } = opts;
  const recalledAt = new Date().toISOString();
  const log: GoalRecallLogRow[] = [];
  for (const r of boosted.slice(0, limit)) {
    const matches = matchesByEntryId.get(r.entry.id);
    if (!matches || matches.length === 0) continue;
    for (const tag of matches) {
      const goal = goalsByTag.get(tag);
      if (!goal) continue;
      log.push({ goalId: goal.id, memoryId: r.entry.id, tenantId, sessionId, recalledAt, score: r.score });
    }
  }
  return log;
}

/** The rows whose memory lives in this store: goal_recall_log.memory_id references memories, so a global row would fail
 *  the insert. A global result keeps its boost; it only earns no log row, so no outcome propagation. */
export function localGoalRecallRows(db: DatabaseSyncLike, rows: readonly GoalRecallLogRow[]): GoalRecallLogRow[] {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.memoryId))];
  // SAFETY: the SELECT projects exactly one column, `id`, from memories.
  const local = db.prepare(`SELECT id FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ id: string }>;
  const localIds = new Set(local.map((r) => r.id));
  return rows.filter((r) => localIds.has(r.memoryId));
}

/** The dlPFC goal-stack boost over goals already read, touching no store: the boosted rows and the log rows for the top `limit` of them.
 *  The caller skips it under an explicit goal tag and recomputes tokens after. Its log keeps rows whose memory is global,
 *  since only the store can tell them apart; {@link localGoalRecallRows} drops those before the write. */
export function boostByGoals<R extends { entry: MemoryEntry; score: number }>(
  results: R[],
  active: ActiveGoals,
  opts: GoalStackBoostOpts,
): GoalStackBoost<R> {
  const { trace } = opts;
  if (active.goals.length === 0) return { results, log: [] };

  const goalsByTag = new Map(active.goals.map((g) => [g.goalName, g]));
  const policiesByGoalId = active.policies;

  // Goal-tag matches per boosted row, keyed by entry id. Kept as a side table
  // (rather than a spread-on `_goalMatches` marker property) so `boosted`
  // stays exactly R[] end to end, with no cast-tag-then-strip round trip.
  const matchesByEntryId = new Map<string, string[]>();

  const boosted = results
    .map((r) => {
      const tags = r.entry.tags ?? [];
      const matches = tags.filter((t) => goalsByTag.has(t));
      if (matches.length === 0) return r;
      const multiplier = goalBoostMultiplier(r.entry, tags, matches, goalsByTag, policiesByGoalId);
      // Recall-trace side-channel: record the goal-boost step BEFORE the
      // score is mutated, keyed by entry id; a pure read of r.score.
      if (trace) {
        trace.set(r.entry.id, {
          stage: 'goal-boost',
          multiplier,
          scoreBefore: r.score,
          scoreAfter: r.score * multiplier,
          note: matches.join(', '),
        });
      }
      matchesByEntryId.set(r.entry.id, matches);
      // SAFETY: spreading a generic-constrained `r: R` widens the result to
      // the spread's plain object type; only `score` changes, so the value
      // still satisfies R's shape exactly.
      return { ...r, score: r.score * multiplier } as R;
    })
    // Deliberately a PLAIN stable score sort, no compareEntryIdentity
    // tail -- a re-sort of an already deterministically-ordered ranking
    // inherits its determinism via sort stability, and ties preserve the
    // prior (meaningful) rank instead of reordering by content.
    .sort((a, b) => compareScoresDesc(a.score, b.score));

  return { results: boosted, log: buildGoalRecallLog(boosted, matchesByEntryId, goalsByTag, opts) };
}

/**
 * Writes goal-boost log rows. INSERT OR IGNORE because UNIQUE(memory_id, goal_id)
 * makes a re-recall during the same goal life a no-op for outcome attribution.
 */
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
const STRENGTH_BOOST = 1.10;
const STRENGTH_DECAY = 0.85;

export interface CompleteGoalOpts {
  outcomeScore?: number;
  /**
   * When true, skip the strength-multiplier propagation block.
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

    withWriteScope(db, 'complete_goal', () => {
      // SAFETY: the row comes from the SELECT above, which projects exactly
      // the created_at and status columns of goal_stack.
      const goalRow = db.prepare(
        `SELECT created_at, status FROM goal_stack WHERE id = ?`,
      ).get(goalId) as { created_at: string; status: string } | undefined;
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
    });
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
    withWriteScope(db, 'resume_goal', () => {
      // SAFETY: the row comes from the SELECT above, which projects exactly
      // the session_id, tenant_id, and status columns of goal_stack.
      const row = db.prepare(
        `SELECT session_id, tenant_id, status FROM goal_stack WHERE id = ?`,
      ).get(goalId) as { session_id: string; tenant_id: string; status: string } | undefined;
      if (!row || row.status !== 'suspended') return;

      enforceDepthCapWithinTx(db, row.tenant_id, row.session_id);

      db.prepare(`UPDATE goal_stack SET status = 'active' WHERE id = ?`).run(goalId);
    });
  } finally {
    closeHippoDb(db);
  }
}
