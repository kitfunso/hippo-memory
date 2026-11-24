import { freshActiveSnapshot } from '../../../base/session/session-snapshot.js';
import {
  HOOK_DB_WAIT_MS,
  sessionOf,
  withWriteScope,
  type DatabaseSyncLike,
} from '../../../db/index.js';
import { raiseMinBinary } from '../../../db/meta.js';
import { assertTenantId } from '../../../base/scope/tenant-id.js';
import { TASK_OWNER_MIN_BINARY } from '../../../base/util/version.js';
import { SESSION_EVENT_COLUMNS, type SessionEventRow, rowToSessionEvent } from '../runtime/rows.js';
import {
  isSnapshotCloseStatus,
  type SessionCalls,
  type SessionClearArgs,
  type SessionEvent,
  type SessionEventInput,
  type SessionReadArgs,
  type Sessions,
  type SessionSaveArgs,
  type SnapshotCloseStatus,
  type WorkingMemoryItem,
  type WorkingMemoryFilter,
  type WorkingMemoryPush,
} from '../../../base/ports/store/sessions.js';
import type { UntracedSession } from '../../../base/ports/store/consolidation.js';
import { removeActiveTaskMirror, writeRecentSessionMirror } from './session-mirrors.js';
import type { Handles, StoreFiles } from '../runtime/open.js';
import { continuityStamp, type ContinuityKey } from '../../../base/ports/store/types.js';
import type { JsonObject } from '../../../base/util/json.js';
import { parseStoredObject } from '../../../base/util/stored-json.js';
import {
  readHandoff,
  readLatestHandoff,
  saveSessionHandoff,
  stampHandoffOutcome,
  writeSessionEndHandoff,
} from './handoffs.js';
import { openStore } from '../runtime/handles.js';
import { bound, type Bodies } from '../runtime/bound.js';
import {
  assertKeyedOnSharedStore,
  continuityWhere,
  readActiveTaskSnapshot,
  saveActiveTaskSnapshot,
} from './task-snapshots.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { RECENT_MIRROR_EVENTS, TRACE_EVENT_ROWS } from '../../rules/windows.js';
import { SESSION_EVENT_LIMIT, WM_MAX_ENTRIES } from '../../../base/util/limits.js';
import { handleNow, handleStamp } from '../runtime/handle-clock.js';
import { badStatusTarget, moveOneStatus } from '../runtime/status-transitions.js';

function requireSnapshotCloseStatus(status: string): SnapshotCloseStatus {
  if (isSnapshotCloseStatus(status)) return status;
  throw badStatusTarget('snapshotClose', status);
}

function clearActiveTaskSnapshot(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  clearedStatus: string,
): number {
  const { hippoRoot } = files;
  assertTenantId('clearActiveTaskSnapshot', tenantId);
  assertKeyedOnSharedStore('clearActiveTaskSnapshot', files, undefined);
  const to = requireSnapshotCloseStatus(clearedStatus);
  const now = handleStamp(db);
  const closed = withWriteScope(db, 'clear_snapshot', () => {
    const active = cachedStatement(
      db,
      `SELECT id FROM task_snapshots WHERE status = 'active' AND tenant_id = ? ORDER BY updated_at DESC, id DESC ` +
        `LIMIT 1`,
    ).get(tenantId) as { id?: number } | undefined;
    if (!active?.id) return 0;
    moveOneStatus(db, 'snapshotClose', { id: active.id, to, tenantId, set: { updated_at: now } });
    return 1;
  });
  removeActiveTaskMirror(hippoRoot, tenantId);
  return closed;
}

interface CloseSnapshotsOptions {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly status: string;
}

function closeTaskSnapshotsForSession(
  db: DatabaseSyncLike,
  { tenantId, sessionId, status }: CloseSnapshotsOptions,
  key: ContinuityKey | null | undefined,
): number {
  assertTenantId('closeTaskSnapshotsForSession', tenantId);
  requireSnapshotCloseStatus(status);
  if (key) continuityStamp(key);
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
    event.task ?? null,
    event.eventType,
    event.content,
    event.source ?? 'cli',
    event.scope ?? null,
    JSON.stringify(event.metadata ?? {}),
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
    clauses.push('task = ?');
    params.push(options.task);
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

function readSessionOwner(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
): string | null {
  const row = cachedStatement(
    db,
    `SELECT owner_subject FROM session_owners WHERE tenant_id = ? AND session_id = ?`,
  ).get(tenantId, sessionId) as { owner_subject: string } | undefined;
  return row?.owner_subject ?? null;
}

interface OwnerRowOptions {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly owner: string;
  readonly createdAt: string;
}

function insertOwnerRow(
  db: DatabaseSyncLike,
  { tenantId, sessionId, owner, createdAt }: OwnerRowOptions,
): number {
  const result = cachedStatement(
    db,
    `INSERT OR IGNORE INTO session_owners(tenant_id, session_id, owner_subject, created_at) VALUES (?, ?, ?, ?)`,
  ).run(tenantId, sessionId, owner, createdAt);
  return Number(result.changes ?? 0);
}

// SHORTCUT: no created_at index, so each first bind scans the table; add one past a few hundred
// thousand rows.
/** Drops bindings created before `cutoffIso`. */
function deleteSessionOwnersBefore(db: DatabaseSyncLike, cutoffIso: string): void {
  cachedStatement(db, `DELETE FROM session_owners WHERE created_at < ?`).run(cutoffIso);
}

interface SessionOwnerBinding {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly owner: string;
  readonly retentionMs: number;
}

function insertSessionOwner(db: DatabaseSyncLike, binding: SessionOwnerBinding): string | null {
  const { tenantId, sessionId, owner, retentionMs } = binding;
  withWriteScope(
    db,
    'bind_session_owner',
    () => {
      const row = { tenantId, sessionId, owner, createdAt: handleStamp(db) };
      const bound = insertOwnerRow(db, row);
      if (bound === 1) raiseMinBinary(db, TASK_OWNER_MIN_BINARY);
      deleteSessionOwnersBefore(db, new Date(handleNow(db).getTime() - retentionMs).toISOString());
    },
    { busyWaitMs: sessionOf(db)?.busyWaitMs ?? HOOK_DB_WAIT_MS },
  );
  return readSessionOwner(db, tenantId, sessionId);
}

function sessionOwnerOrBind(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  owner: string,
  retentionMs: number,
): string | null {
  return (
    readSessionOwner(db, tenantId, sessionId) ??
    insertSessionOwner(db, { tenantId, sessionId, owner, retentionMs })
  );
}

// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
interface WorkingMemoryRow {
  id: number;
  scope: string;
  session_id: string | null;
  task_id: string | null;
  importance: number;
  content: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

function rowToItem(row: WorkingMemoryRow): WorkingMemoryItem {
  const metadata: JsonObject =
    parseStoredObject(
      { table: 'working_memory', id: row.id, column: 'metadata_json' },
      row.metadata_json,
    ) ?? {};
  return {
    id: row.id,
    scope: row.scope,
    sessionId: row.session_id,
    taskId: row.task_id,
    importance: Number(row.importance),
    content: row.content,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function wmPush(db: DatabaseSyncLike, tenantId: string, item: WorkingMemoryPush): number {
  const now = handleStamp(db);
  return withWriteScope(db, 'wm_push', () => {
    const result = cachedStatement(
      db,
      `
      INSERT INTO working_memory(scope, session_id, task_id, importance, content, metadata_json, created_at,
      updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      item.scope,
      item.sessionId ?? null,
      item.taskId ?? null,
      item.importance ?? 0,
      item.content,
      JSON.stringify(item.metadata ?? {}),
      now,
      now,
      tenantId,
    );

    const id = Number(result.lastInsertRowid ?? 0);

    evictOverCapacity(db, item.scope, tenantId);

    return id;
  });
}

function evictOverCapacity(db: DatabaseSyncLike, scope: string, tenantId: string): void {
  const countRow = cachedStatement(
    db,
    `
    SELECT COUNT(*) AS cnt FROM working_memory WHERE scope = ? AND tenant_id = ?
  `,
  ).get(scope, tenantId) as { cnt: number } | undefined;

  const count = Number(countRow?.cnt ?? 0);
  if (count > WM_MAX_ENTRIES) {
    const excess = count - WM_MAX_ENTRIES;
    cachedStatement(
      db,
      `
      DELETE FROM working_memory
      WHERE id IN (
        SELECT id FROM working_memory
        WHERE scope = ? AND tenant_id = ?
        ORDER BY importance ASC, created_at ASC, id ASC
        LIMIT ?
      )
    `,
    ).run(scope, tenantId, excess);
  }
}

function wmWhere(tenantId: string, filter: WorkingMemoryFilter) {
  const clauses = ['tenant_id = ?'];
  const params = [tenantId];
  if (filter.scope) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.sessionId) {
    clauses.push('session_id = ?');
    params.push(filter.sessionId);
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

function wmRead(
  db: DatabaseSyncLike,
  tenantId: string,
  filter: WorkingMemoryFilter & { readonly limit?: number },
): WorkingMemoryItem[] {
  const where = wmWhere(tenantId, filter);
  const limit = Math.max(1, Math.trunc(filter.limit ?? WM_MAX_ENTRIES));
  const rows = cachedStatement(
    db,
    `
    SELECT id, scope, session_id, task_id, importance, content, metadata_json, created_at, updated_at
    FROM working_memory
    ${where.sql}
    ORDER BY importance DESC, created_at DESC, id DESC
    LIMIT ?
  `,
  ).all(...where.params, limit) as WorkingMemoryRow[];

  return rows.map(rowToItem);
}

function wmClear(db: DatabaseSyncLike, tenantId: string, filter: WorkingMemoryFilter): number {
  const where = wmWhere(tenantId, filter);
  const result = cachedStatement(db, `DELETE FROM working_memory ${where.sql}`).run(
    ...where.params,
  );
  return Number(result.changes ?? 0);
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
