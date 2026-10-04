import { closeHippoDb } from '../db.js';
import { assertTenantId } from '../tenant.js';
import { redactSecretsStrict } from '../secret-detect.js';
import {
  type TaskSnapshot,
  type TaskSnapshotRow,
  rowToTaskSnapshot,
  type SessionEvent,
  type SessionEventRow,
  rowToSessionEvent,
} from './rows.js';
import { writeActiveTaskMirror, removeActiveTaskMirror, writeRecentSessionMirror } from './mirrors.js';
import { openStore } from './open.js';

export function saveActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  snapshot: {
    task: string;
    summary: string;
    next_step: string;
    source?: string;
    session_id?: string | null;
    scope?: string | null;
  }
): TaskSnapshot {
  assertTenantId('saveActiveTaskSnapshot', tenantId);
  const db = openStore(hippoRoot);
  const now = new Date().toISOString();

  try {
    db.exec('BEGIN');
    db.prepare(`UPDATE task_snapshots SET status = 'superseded', updated_at = ? WHERE status = 'active' AND tenant_id = ?`).run(now, tenantId);

    const result = db.prepare(`
      INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, scope, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      redactSecretsStrict(snapshot.task),
      redactSecretsStrict(snapshot.summary),
      redactSecretsStrict(snapshot.next_step),
      snapshot.source ?? 'cli',
      snapshot.session_id ?? null,
      snapshot.scope ?? null,
      tenantId,
      now,
      now,
    );

    db.exec('COMMIT');

    const id = Number(result.lastInsertRowid ?? 0);
    // SAFETY: row's shape matches the ten columns named in the SELECT above.
    const row = db.prepare(`
      SELECT id, task, summary, next_step, status, source, session_id, scope, created_at, updated_at
      FROM task_snapshots
      WHERE id = ?
    `).get(id) as TaskSnapshotRow | undefined;

    if (!row) {
      throw new Error('Failed to reload saved active task snapshot');
    }

    const loaded = rowToTaskSnapshot(row);
    writeActiveTaskMirror(hippoRoot, tenantId, loaded);
    return loaded;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore nested rollback failures.
    }
    throw error;
  } finally {
    closeHippoDb(db);
  }
}

export function loadActiveTaskSnapshot(hippoRoot: string, tenantId: string): TaskSnapshot | null {
  assertTenantId('loadActiveTaskSnapshot', tenantId);
  const db = openStore(hippoRoot);
  try {
    // SAFETY: row's shape matches the ten columns named in the SELECT above.
    const row = db.prepare(`
      SELECT id, task, summary, next_step, status, source, session_id, scope, created_at, updated_at
      FROM task_snapshots
      WHERE status = 'active' AND tenant_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(tenantId) as TaskSnapshotRow | undefined;

    if (!row) {
      removeActiveTaskMirror(hippoRoot, tenantId);
      return null;
    }

    const loaded = rowToTaskSnapshot(row);
    writeActiveTaskMirror(hippoRoot, tenantId, loaded);
    return loaded;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Default freshness bound for AMBIENT active-task-snapshot reads (DF1,
 * docs/plans/2026-08-23-df1-snapshot-lifecycle.md): 72h, chosen over 48h so
 * a Friday-evening orphan still offers continuity on Monday morning.
 * Exported so callers can override via `loadFreshActiveTaskSnapshot`'s
 * `opts.maxAgeMs`; deliberately no env knob (Simplicity First).
 */
export const SNAPSHOT_AMBIENT_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/** A usable session id: non-null, non-empty string. Named predicate (not an
 * inline `typeof` check) so the owner-match rule in
 * `loadFreshActiveTaskSnapshot` states its contract once. */
function isNonEmptySessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Bounded read for AMBIENT active-task-snapshot surfaces (UserPromptSubmit
 * hook context, MCP recall block) — the never-expires fix for DF1. A
 * snapshot written by `hippo pre-compact` has no death path tied to the
 * session that owns it, so an orphaned row would otherwise inject into
 * every prompt of every later session forever. Wraps `loadActiveTaskSnapshot`
 * (unchanged, still the source of truth for explicit continuity surfaces),
 * then applies, in order:
 *
 * 1. Owner match — ONLY when both `opts.sessionId` and the snapshot's
 *    `session_id` are non-null, non-empty strings and strictly equal
 *    (`===`). Owner reads are unbounded: the session that owns the snapshot
 *    can always see its own working state, regardless of age.
 * 2. Age check — everything else, including absent-vs-absent ids. A
 *    null/undefined/empty id on EITHER side never counts as an owner match;
 *    it falls through here instead. (`runPreCompact` can legitimately save a
 *    snapshot with `session_id = null`; a null-equals-null "match" would
 *    reopen indefinite ambient injection for exactly those rows.) Returns
 *    the snapshot only when `age(updated_at) <= maxAgeMs` (default
 *    `SNAPSHOT_AMBIENT_MAX_AGE_MS`); otherwise null.
 *
 * No SQL change — age derives from the existing `updated_at` column.
 */
export function loadFreshActiveTaskSnapshot(
  hippoRoot: string,
  tenantId: string,
  opts: { maxAgeMs?: number; sessionId?: string | null } = {},
): TaskSnapshot | null {
  const snapshot = loadActiveTaskSnapshot(hippoRoot, tenantId);
  if (!snapshot) return null;

  const callerSessionId = opts.sessionId;
  const isOwnerMatch =
    isNonEmptySessionId(callerSessionId) &&
    isNonEmptySessionId(snapshot.session_id) &&
    callerSessionId === snapshot.session_id;
  if (isOwnerMatch) return snapshot;

  const maxAgeMs = opts.maxAgeMs ?? SNAPSHOT_AMBIENT_MAX_AGE_MS;
  const ageMs = Date.now() - Date.parse(snapshot.updated_at);
  return ageMs <= maxAgeMs ? snapshot : null;
}

export function clearActiveTaskSnapshot(hippoRoot: string, tenantId: string, clearedStatus: string = 'cleared'): boolean {
  assertTenantId('clearActiveTaskSnapshot', tenantId);
  const db = openStore(hippoRoot);
  const now = new Date().toISOString();

  try {
    // SAFETY: active's shape matches the single `id` column selected above.
    const active = db.prepare(`SELECT id FROM task_snapshots WHERE status = 'active' AND tenant_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`).get(tenantId) as { id?: number } | undefined;
    if (!active?.id) {
      removeActiveTaskMirror(hippoRoot, tenantId);
      return false;
    }

    db.prepare(`UPDATE task_snapshots SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`).run(clearedStatus, now, active.id, tenantId);
    removeActiveTaskMirror(hippoRoot, tenantId);
    return true;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Close the `active` task snapshot(s) owned by `sessionId`, for the T3
 * session-end death path (DF1, docs/plans/2026-08-23-df1-snapshot-lifecycle.md).
 * Only one `active` row exists per tenant in practice (supersession happens
 * at save), but the WHERE clause scopes on `session_id` too — not just
 * `status='active' AND tenant_id=?` — so an ending session can never close a
 * different, newer session's active snapshot. Returns the number of rows
 * closed (0 when no active row is owned by `sessionId`).
 */
export function closeTaskSnapshotsForSession(
  hippoRoot: string,
  tenantId: string,
  sessionId: string,
  status: string = 'session-ended',
): number {
  assertTenantId('closeTaskSnapshotsForSession', tenantId);
  const db = openStore(hippoRoot);
  const now = new Date().toISOString();

  try {
    const result = db.prepare(
      `UPDATE task_snapshots SET status = ?, updated_at = ? WHERE status = 'active' AND tenant_id = ? AND session_id = ?`,
    ).run(status, now, tenantId, sessionId);
    return Number(result.changes ?? 0);
  } finally {
    closeHippoDb(db);
  }
}

export function appendSessionEvent(
  hippoRoot: string,
  tenantId: string,
  event: {
    session_id: string;
    event_type: string;
    content: string;
    task?: string | null;
    source?: string;
    scope?: string | null;
    metadata?: Record<string, unknown>;
  }
): SessionEvent {
  assertTenantId('appendSessionEvent', tenantId);
  const db = openStore(hippoRoot);
  const now = new Date().toISOString();

  // v1.2: scope is wired through. Default-deny in api.recall + cmdRecall
  // continuity reads applies to slack:private:* and 'unknown:legacy' rows.
  try {
    const result = db.prepare(`
      INSERT INTO session_events(session_id, task, event_type, content, source, scope, metadata_json, tenant_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.session_id,
      event.task ?? null,
      event.event_type,
      event.content,
      event.source ?? 'cli',
      event.scope ?? null,
      JSON.stringify(event.metadata ?? {}),
      tenantId,
      now,
    );

    const id = Number(result.lastInsertRowid ?? 0);
    // SAFETY: row's shape matches the nine columns named in the SELECT
    // above.
    const row = db.prepare(`
      SELECT id, session_id, task, event_type, content, source, scope, metadata_json, created_at
      FROM session_events
      WHERE id = ?
    `).get(id) as SessionEventRow | undefined;

    if (!row) {
      throw new Error('Failed to reload saved session event');
    }

    const loaded = rowToSessionEvent(row);
    // SAFETY: recentRows' shape matches the nine columns named in the
    // SELECT above.
    const recentRows = db.prepare(`
      SELECT id, session_id, task, event_type, content, source, scope, metadata_json, created_at
      FROM session_events
      WHERE session_id = ? AND tenant_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(loaded.session_id, tenantId, 20) as SessionEventRow[];
    const recent = recentRows.map(rowToSessionEvent).reverse();
    writeRecentSessionMirror(hippoRoot, tenantId, recent);
    return loaded;
  } finally {
    closeHippoDb(db);
  }
}

export function listSessionEvents(
  hippoRoot: string,
  tenantId: string,
  options: { session_id?: string; task?: string; limit?: number } = {}
): SessionEvent[] {
  assertTenantId('listSessionEvents', tenantId);
  const db = openStore(hippoRoot);
  try {
    const clauses: string[] = ['tenant_id = ?'];
    const params: Array<string | number> = [tenantId];

    if (options.session_id) {
      clauses.push('session_id = ?');
      params.push(options.session_id);
    }
    if (options.task) {
      clauses.push('task = ?');
      params.push(options.task);
    }

    const limit = Math.max(1, Math.trunc(options.limit ?? 8));
    params.push(limit);

    const where = `WHERE ${clauses.join(' AND ')}`;
    // SAFETY: rows' shape matches the nine columns named in the SELECT
    // above.
    const rows = db.prepare(`
      SELECT id, session_id, task, event_type, content, source, scope, metadata_json, created_at
      FROM session_events
      ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as SessionEventRow[];

    return rows.map(rowToSessionEvent).reverse();
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Return session_ids with a `session_complete` event newer than `sinceMs`.
 * Used by the sleep auto-promotion pass to bound scanning to a fixed window.
 */
export function findPromotableSessions(
  hippoRoot: string,
  tenantId: string,
  sinceMs: number,
): Array<{ session_id: string }> {
  assertTenantId('findPromotableSessions', tenantId);
  const db = openStore(hippoRoot);
  try {
    // SAFETY: rows' shape matches the single `session_id` column selected
    // above.
    const rows = db.prepare(`
      SELECT DISTINCT session_id FROM session_events
      WHERE event_type = 'session_complete' AND created_at >= ? AND tenant_id = ?
    `).all(new Date(sinceMs).toISOString(), tenantId) as { session_id: string }[];
    return rows;
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Idempotency guard — true if a trace-layer memory with this source_session_id
 * already exists.
 */
export function traceExistsForSession(hippoRoot: string, tenantId: string, session_id: string): boolean {
  assertTenantId('traceExistsForSession', tenantId);
  const db = openStore(hippoRoot);
  try {
    const row = db.prepare(`
      SELECT 1 FROM memories
      WHERE source_session_id = ? AND layer = 'trace' AND tenant_id = ?
      LIMIT 1
    `).get(session_id, tenantId);
    return !!row;
  } finally {
    closeHippoDb(db);
  }
}
