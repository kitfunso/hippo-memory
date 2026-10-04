import { closeHippoDb, openHippoDb } from '../db.js';
import {
  type SessionHandoff,
  type SessionHandoffRow,
  rowToSessionHandoff,
  type HandoffOutcome,
  type HandoffEvidence,
  isHandoffOutcome,
} from '../handoff.js';
import { RECALL_DEFAULT_DENY_SCOPES } from '../recall-scope.js';
import { assertTenantId } from '../tenant.js';
import type { TaskSnapshot } from './rows.js';
import { openStore } from './open.js';
import { loadActiveTaskSnapshot } from './sessions.js';

// W1: the nine-column SELECT was cloned four times (plan rule 8); one
// definition so a sixth caller can't drift from the other five.
/** Column list shared by every session_handoffs SELECT; store-cards.ts reuses it for the card handoff lookup. */
export const HANDOFF_COLUMNS = 'id, session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, created_at, constraints_json, evidence_json, outcome, target_runtime, card_id';

/**
 * Save a session handoff record. Returns the persisted handoff.
 */
export function saveSessionHandoff(
  hippoRoot: string,
  tenantId: string,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
): SessionHandoff {
  assertTenantId('saveSessionHandoff', tenantId);
  const db = openStore(hippoRoot);
  const now = new Date().toISOString();

  // v1.2: scope is wired through. Read-side default-deny in api.recall +
  // cmdRecall continuity excludes slack:private:* and 'unknown:legacy'.
  try {
    const result = db.prepare(`
      INSERT INTO session_handoffs(session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, tenant_id, created_at, constraints_json, evidence_json, outcome, target_runtime, card_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoff.sessionId,
      handoff.repoRoot ?? null,
      handoff.taskId ?? null,
      handoff.summary,
      handoff.nextAction ?? null,
      JSON.stringify(handoff.artifacts ?? []),
      handoff.scope ?? null,
      tenantId,
      now,
      JSON.stringify(handoff.constraints ?? []),
      handoff.evidence ? JSON.stringify(handoff.evidence) : null,
      handoff.outcome ?? null,
      handoff.targetRuntime ?? null,
      handoff.cardId ?? null,
    );

    const id = Number(result.lastInsertRowid ?? 0);
    // SAFETY: row's shape matches HANDOFF_COLUMNS.
    const row = db.prepare(`
      SELECT ${HANDOFF_COLUMNS}
      FROM session_handoffs
      WHERE id = ?
    `).get(id) as SessionHandoffRow | undefined;

    if (!row) {
      throw new Error('Failed to reload saved session handoff');
    }

    return rowToSessionHandoff(row);
  } finally {
    closeHippoDb(db);
  }
}

/** Load the most recent handoff, optionally filtered by session ID. */
export function loadLatestHandoff(
  hippoRoot: string,
  tenantId: string,
  sessionId?: string,
  opts: { unfinishedOnly?: boolean; maxAgeMs?: number; scopeFilter?: 'default-deny'; excludeSessionId?: string } = {},
): SessionHandoff | null {
  assertTenantId('loadLatestHandoff', tenantId);
  const db = openStore(hippoRoot);

  try {
    const conditions: string[] = ['tenant_id = ?'];
    const params: Array<string | number> = [tenantId];
    if (sessionId) {
      conditions.push('session_id = ?');
      params.push(sessionId);
    }
    if (opts.excludeSessionId) {
      conditions.push('session_id != ?');
      params.push(opts.excludeSessionId);
    }
    if (opts.unfinishedOnly) {
      // codex P2: restrict to each session's newest revision first — stampHandoffOutcome
      // only stamps the newest row, so an older null-outcome revision must not resurrect.
      conditions.push(`id IN (SELECT MAX(id) FROM session_handoffs WHERE tenant_id = ? GROUP BY session_id)`);
      params.push(tenantId);
      conditions.push(`(outcome IS NULL OR outcome IN ('partial','failure'))`);
    }
    if (opts.maxAgeMs != null) {
      conditions.push('created_at >= ?');
      params.push(new Date(Date.now() - opts.maxAgeMs).toISOString());
    }
    if (opts.scopeFilter === 'default-deny') {
      // codex P2: admit scope before LIMIT 1, else a newer denied row hides an older eligible one.
      const placeholders = RECALL_DEFAULT_DENY_SCOPES.map(() => '?').join(', ');
      conditions.push(`(scope IS NULL OR (scope NOT IN (${placeholders}) AND scope NOT LIKE '%:private:%'))`);
      params.push(...RECALL_DEFAULT_DENY_SCOPES);
    }

    // SAFETY: row's shape matches HANDOFF_COLUMNS.
    const row = db.prepare(`
      SELECT ${HANDOFF_COLUMNS}
      FROM session_handoffs
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(...params) as SessionHandoffRow | undefined;

    return row ? rowToSessionHandoff(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load a specific handoff by its row ID.
 */
export function loadHandoffById(hippoRoot: string, tenantId: string, id: number): SessionHandoff | null {
  assertTenantId('loadHandoffById', tenantId);
  const db = openStore(hippoRoot);

  try {
    // SAFETY: row's shape matches HANDOFF_COLUMNS.
    const row = db.prepare(`
      SELECT ${HANDOFF_COLUMNS}
      FROM session_handoffs
      WHERE id = ? AND tenant_id = ?
    `).get(id, tenantId) as SessionHandoffRow | undefined;

    return row ? rowToSessionHandoff(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

/** Stamp the outcome on a session's newest handoff, only if it has none yet. Returns rows changed. */
export function stampHandoffOutcome(hippoRoot: string, tenantId: string, sessionId: string, outcome: HandoffOutcome): number {
  assertTenantId('stampHandoffOutcome', tenantId);
  const db = openStore(hippoRoot);
  try {
    const result = db.prepare(`
      UPDATE session_handoffs SET outcome = ?
      WHERE tenant_id = ? AND session_id = ? AND outcome IS NULL
        AND id = (
          SELECT id FROM session_handoffs
          WHERE tenant_id = ? AND session_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1
        )
    `).run(outcome, tenantId, sessionId, tenantId, sessionId);
    return Number(result.changes ?? 0);
  } finally {
    closeHippoDb(db);
  }
}

/** Auto-write a handoff at session-end (DF1 T3) from the session's active snapshot, else from `derived`, its transcript state.
 * @param evidence best-effort git state; outcome comes from the newest session_complete event.
 * @returns null when neither source is the session's, a newer handoff covers the snapshot, or the session's latest handoff was not read off its transcript. */
export function writeSessionEndHandoff(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  evidence: HandoffEvidence | null,
  derived: Pick<TaskSnapshot, 'task' | 'summary' | 'next_step'> | null = null,
): SessionHandoff | null {
  assertTenantId('writeSessionEndHandoff', tenantId);
  const active = loadActiveTaskSnapshot(hippoRoot, tenantId);
  const existing = loadLatestHandoff(hippoRoot, tenantId, sessionId);
  let snapshot: Pick<TaskSnapshot, 'task' | 'summary' | 'next_step' | 'scope'>;
  let handoffEvidence = evidence;
  if (active && active.session_id === sessionId) {
    // Strict '>': a same-millisecond tie must not swallow the session's only write (test 6e).
    if (existing && existing.updatedAt > active.updated_at) return null;
    snapshot = active;
  } else {
    // Only an earlier transcript read gives way; `hippo handoff create` and unmarked older handoffs keep winning.
    if (!derived || (existing && existing.evidence?.derivedFrom !== 'transcript')) return null;
    snapshot = { ...derived, scope: null };
    handoffEvidence = { ...evidence, derivedFrom: 'transcript' };
  }

  const db = openHippoDb(hippoRoot);
  let outcome: HandoffOutcome | null = null;
  try {
    // SAFETY: row's shape matches the single `content` column below.
    const completeEvent = db.prepare(`
      SELECT content FROM session_events
      WHERE tenant_id = ? AND session_id = ? AND event_type = 'session_complete'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(tenantId, sessionId) as { content?: string } | undefined;
    if (isHandoffOutcome(completeEvent?.content)) outcome = completeEvent!.content;
  } finally {
    closeHippoDb(db);
  }

  // codex P2: same-task refresh carries forward envelope fields nobody cleared,
  // rather than dropping them when the snapshot rewrite has no opinion on them.
  // codex P1: a scope mismatch must not leak private metadata into an unscoped envelope.
  const carryForward = existing != null && existing.taskId === snapshot.task
    && (existing.scope ?? null) === (snapshot.scope ?? null);

  return saveSessionHandoff(hippoRoot, tenantId, {
    version: 1,
    sessionId,
    repoRoot: carryForward ? existing.repoRoot : undefined,
    taskId: snapshot.task,
    summary: snapshot.summary,
    nextAction: snapshot.next_step,
    artifacts: carryForward ? existing.artifacts : [],
    scope: snapshot.scope,
    evidence: handoffEvidence,
    outcome,
    constraints: carryForward ? existing.constraints : undefined,
    targetRuntime: carryForward ? existing.targetRuntime : undefined,
    cardId: carryForward ? existing.cardId : undefined,
  });
}
