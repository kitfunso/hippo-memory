// hippo.db's Sessions group: snapshots, session events, handoffs, working memory and session-owner
// binding.
import { freshActiveSnapshot } from '../../base/session/session-snapshot.js';
import { type DatabaseSyncLike } from '../../db/index.js';
import { redactPayload, redactSecretsStrict, storedOrNull } from '../../base/util/secret-detect.js';
import { holdsTextSql } from './rule-sql.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import { SESSION_EVENT_COLUMNS, type SessionEventRow, rowToSessionEvent } from './rows.js';
import type {
  SessionCalls,
  SessionClearArgs,
  SessionEvent,
  SessionEventInput,
  SessionReadArgs,
  Sessions,
  SessionSaveArgs,
} from '../../base/ports/store/sessions.js';
import type { UntracedSession } from '../../base/ports/store/consolidation.js';
import { removeActiveTaskMirror, writeRecentSessionMirror } from './mirrors.js';
import type { Handles, StoreFiles } from './open.js';
import { continuityStamp, type ContinuityKey } from '../../base/ports/store/types.js';
import {
  readHandoff,
  readLatestHandoff,
  saveSessionHandoff,
  stampHandoffOutcome,
  writeSessionEndHandoff,
} from './handoffs.js';
import { openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';
import {
  assertKeyedOnSharedStore,
  continuityWhere,
  readActiveTaskSnapshot,
  saveActiveTaskSnapshot,
} from './task-snapshots.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { RECENT_MIRROR_EVENTS, TRACE_EVENT_ROWS } from '../rules/windows.js';
import { SESSION_EVENT_LIMIT } from '../../base/util/limits.js';
import { handleStamp } from './handle-clock.js';
import { sessionOwnerOrBind } from './session-owners.js';
import { wmClear, wmPush, wmRead } from './working-memory.js';
/** Rows closed: the tenant's newest active snapshot, whoever saved it, or none. */
function clearActiveTaskSnapshot(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  clearedStatus: string,
): number {
  const { hippoRoot } = files;
  assertTenantId('clearActiveTaskSnapshot', tenantId);
  assertKeyedOnSharedStore('clearActiveTaskSnapshot', files, undefined);
  const now = handleStamp(db);
  const active = cachedStatement(
    db,
    `SELECT id FROM task_snapshots WHERE status = 'active' AND tenant_id = ? ORDER BY updated_at DESC, id DESC ` +
      `LIMIT 1`,
  ).get(tenantId) as { id?: number } | undefined;
  if (!active?.id) {
    removeActiveTaskMirror(hippoRoot, tenantId);
    return 0;
  }

  cachedStatement(
    db,
    `UPDATE task_snapshots SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
  ).run(clearedStatus, now, active.id, tenantId);
  removeActiveTaskMirror(hippoRoot, tenantId);
  return 1;
}

/** An ending session and the status its active snapshots close with. */
interface CloseSnapshotsOptions {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly status: string;
}

/** Close the `active` task snapshot(s) owned by `sessionId` at session end; the WHERE scopes on
 * `session_id` too so an ending session can never close a newer session's snapshot. Returns the
 * number of rows closed. */
function closeTaskSnapshotsForSession(
  db: DatabaseSyncLike,
  { tenantId, sessionId, status }: CloseSnapshotsOptions,
  key: ContinuityKey | null | undefined,
): number {
  assertTenantId('closeTaskSnapshotsForSession', tenantId);
  if (key) continuityStamp(key);
  // a partial key is a caller bug, so fail loud rather than close nothing
  const owned = key ? continuityWhere(key) : null;
  const now = handleStamp(db);
  const result = cachedStatement(
    db,
    `UPDATE task_snapshots SET status = ?, updated_at = ? WHERE status = 'active' AND tenant_id = ? AND ` +
      `session_id = ?${owned ? ` AND ${owned.sql}` : ''}`,
  ).run(status, now, tenantId, sessionId, ...(owned?.params ?? []));
  return Number(result.changes ?? 0);
}

function insertSessionEventRow(
  db: DatabaseSyncLike,
  tenantId: string,
  event: SessionEventInput,
  now: string,
): number {
  const result = cachedStatement(
    db,
    `
      INSERT INTO session_events(session_id, task, event_type, content, source, scope, metadata_json, tenant_id,
      created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    event.sessionId,
    storedOrNull(event.task),
    event.eventType,
    redactSecretsStrict(event.content),
    event.source ?? 'cli',
    event.scope ?? null,
    redactPayload(JSON.stringify(event.metadata ?? {})),
    tenantId,
    now,
  );
  return Number(result.lastInsertRowid ?? 0);
}

function reloadSessionEvent(db: DatabaseSyncLike, id: number): SessionEvent {
  const row = cachedStatement(
    db,
    `
      SELECT ${SESSION_EVENT_COLUMNS}
      FROM session_events
      WHERE id = ?
    `,
  ).get(id) as SessionEventRow | undefined;

  if (!row) {
    throw new Error('Failed to reload saved session event');
  }
  return rowToSessionEvent(row);
}

function recentSessionEventsOldestFirst(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  limit: number,
): SessionEvent[] {
  const recentRows = cachedStatement(
    db,
    `
      SELECT ${SESSION_EVENT_COLUMNS}
      FROM session_events
      WHERE session_id = ? AND tenant_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
  ).all(sessionId, tenantId, limit) as SessionEventRow[];
  return recentRows.map(rowToSessionEvent).reverse();
}

function appendSessionEvent(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  tenantId: string,
  event: SessionEventInput,
): SessionEvent {
  assertTenantId('appendSessionEvent', tenantId);
  const now = handleStamp(db);

  // Scope is stored as given, since reads deny by default.
  // api.recall and printRecall continuity reads skip slack:private:* and 'unknown:legacy' rows.
  const loaded = reloadSessionEvent(db, insertSessionEventRow(db, tenantId, event, now));
  const recent = recentSessionEventsOldestFirst(
    db,
    tenantId,
    loaded.sessionId,
    RECENT_MIRROR_EVENTS,
  );
  writeRecentSessionMirror(hippoRoot, tenantId, recent);
  return loaded;
}

export function listSessionEvents(
  db: DatabaseSyncLike,
  tenantId: string,
  options: { session_id?: string; task?: string; limit?: number } = {},
): SessionEvent[] {
  assertTenantId('listSessionEvents', tenantId);
  const clauses: string[] = ['tenant_id = ?'];
  const params: Array<string | number> = [tenantId];

  if (options.session_id) {
    clauses.push('session_id = ?');
    params.push(options.session_id);
  }
  if (options.task) {
    const task = holdsTextSql('task', options.task);
    clauses.push(task.sql);
    params.push(...task.params);
  }

  const limit = Math.max(1, Math.trunc(options.limit ?? SESSION_EVENT_LIMIT));
  params.push(limit);

  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = cachedStatement(
    db,
    `
    SELECT ${SESSION_EVENT_COLUMNS}
    FROM session_events
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
  ).all(...params) as SessionEventRow[];

  return rows.map(rowToSessionEvent).reverse();
}

/** The tenant's sessions completed since `sinceMs` with no trace yet, each with its newest
 * TRACE_EVENT_ROWS events oldest first: two statements for any number of sessions. */
export function listUntracedSessions(
  db: DatabaseSyncLike,
  tenantId: string,
  sinceMs: number,
): UntracedSession[] {
  assertTenantId('listUntracedSessions', tenantId);
  // SAFETY: one TEXT column, session_id.
  const ids = (
    cachedStatement(
      db,
      `SELECT DISTINCT e.session_id AS session_id FROM session_events e ` +
        `WHERE e.event_type = 'session_complete' AND e.created_at >= ? AND e.tenant_id = ? AND NOT EXISTS ` +
        `(SELECT 1 FROM memories m WHERE m.source_session_id = e.session_id AND m.layer = 'trace' ` +
        `AND m.tenant_id = e.tenant_id)`,
    ).all(new Date(sinceMs).toISOString(), tenantId) as Array<{ session_id: string }>
  ).map((row) => row.session_id);
  if (ids.length === 0) return [];
  const rows = cachedStatement(
    db,
    `SELECT ${SESSION_EVENT_COLUMNS} FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ` +
      `ORDER BY created_at DESC, id DESC) AS newest FROM session_events ` +
      `WHERE tenant_id = ? AND session_id IN (SELECT value FROM json_each(?))) ` +
      `WHERE newest <= ? ORDER BY created_at ASC, id ASC`,
  ).all(tenantId, JSON.stringify(ids), TRACE_EVENT_ROWS) as SessionEventRow[];
  const events = new Map<string, SessionEvent[]>(ids.map((id) => [id, []]));
  for (const row of rows) events.get(row.session_id)?.push(rowToSessionEvent(row));
  return ids.map((sessionId) => ({ sessionId, events: events.get(sessionId) ?? [] }));
}

function saveAny(
  db: DatabaseSyncLike,
  files: StoreFiles,
  ...[tenantId, kind, row, key]: SessionSaveArgs
) {
  if (kind === 'snapshot') {
    return saveActiveTaskSnapshot(db, { files, tenantId, snapshot: row, key });
  }
  if (kind === 'event') return appendSessionEvent(db, files, tenantId, row);
  if (kind === 'working_memory') return wmPush(db, tenantId, row);
  if ('handoff' in row) return saveSessionHandoff(db, tenantId, row.handoff, key);
  if ('sessionEnd' in row) {
    return writeSessionEndHandoff(db, { files, tenantId, request: row.sessionEnd, key });
  }
  return stampHandoffOutcome(db, tenantId, row.sessionId, row.outcome);
}

function readAny(db: DatabaseSyncLike, ...[tenantId, kind, query, key]: SessionReadArgs) {
  // The port names the session in camelCase; the event rows keep their column's name.
  if (kind === 'event') {
    return listSessionEvents(db, tenantId, {
      session_id: query.sessionId,
      task: query.task,
      limit: query.limit,
    });
  }
  if (kind === 'working_memory') return wmRead(db, tenantId, query);
  if ('id' in query) return readHandoff(db, tenantId, query.id);
  return readLatestHandoff(db, { tenantId, sessionId: query.sessionId, opts: query, key });
}

function clearAny(
  db: DatabaseSyncLike,
  files: StoreFiles,
  ...[tenantId, kind, close, key]: SessionClearArgs
) {
  if (kind === 'working_memory') return wmClear(db, tenantId, close);
  if (close.sessionId === undefined) {
    return clearActiveTaskSnapshot(db, files, tenantId, close.status);
  }
  const closing = { tenantId, sessionId: close.sessionId, status: close.status };
  return closeTaskSnapshotsForSession(db, closing, key);
}

// Each kind writes or reads the session's mirror files beside hippo.db as well as its rows.
function sessionBodies(files: StoreFiles): Bodies<Omit<SessionCalls, 'bindSessionOwner'>> {
  return {
    save: (db, ...args) => saveAny(db, files, ...args),
    read: readAny,
    clear: (db, ...args) => clearAny(db, files, ...args),
    loadSnapshot: (db, tenantId, { ambient }, key) => {
      const active = readActiveTaskSnapshot(db, files, tenantId, key);
      return ambient ? freshActiveSnapshot(active, ambient) : active;
    },
  };
}

export function sqliteSessions({ on, files }: Handles): Sessions {
  const sessions: SessionCalls = {
    ...bound(on, sessionBodies(files), openStore),
    ...bound<Pick<Sessions, 'bindSessionOwner'>>(on, { bindSessionOwner: sessionOwnerOrBind }),
  };
  // SAFETY: each body picks its statement from the kind and the payload's shape, the pairs the
  // port's overloads name, so every overload gets the answer its kind declares.
  return sessions as Sessions;
}
