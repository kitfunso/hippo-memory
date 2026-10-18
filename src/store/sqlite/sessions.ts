// hippo.db's Sessions group: snapshots, session events, handoffs, working memory and session-owner binding.
import { freshActiveSnapshot } from '../../core/session-snapshot.js';
import { HOOK_DB_WAIT_MS, scopedBusyWait, withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { raiseMinBinary } from '../../db/meta.js';
import { assertTenantId } from '../../core/tenant-id.js';
import { TASK_OWNER_MIN_BINARY } from '../../util/version.js';
import { type SessionEventRow, rowToSessionEvent } from './rows.js';
import type { TaskSnapshot, SessionEvent, SessionEventInput, WorkingMemoryItem } from '../port/sessions.js';
import { removeActiveTaskMirror, writeRecentSessionMirror } from './mirrors.js';
import type { StoreFiles, OnHandle } from './open.js';
import type { ContinuityKey, JsonObject } from '../port/types.js';
import { warnDamagedColumn } from '../../util/stored-json.js';
import { resolveTenantId } from './tenant.js';
import {
  loadHandoffByIdAt,
  loadLatestHandoffAt,
  saveSessionHandoffAt,
  stampHandoffOutcomeAt,
  writeSessionEndHandoffAt,
} from './handoffs.js';
import type { Sessions } from '../port-groups.js';
import type { Sync } from '../port.js';
import { openStore } from './handles.js';
import {
  assertKeyedOnSharedStore,
  continuityStamp,
  continuityWhere,
  loadActiveTaskSnapshotAt,
  saveActiveTaskSnapshotAt,
} from './task-snapshots.js';

/** Bounded read for AMBIENT snapshot surfaces so orphaned snapshots expire. The owner (both session ids non-empty and
 * `===`) always sees its own state; all others, null ids included (null === null is no match), get it only if
 * age(updated_at) <= maxAgeMs (default `SNAPSHOT_AMBIENT_MAX_AGE_MS`), else null. */
function loadFreshActiveTaskSnapshotAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  opts: { maxAgeMs?: number; sessionId?: string | null } = {},
  key?: ContinuityKey,
): TaskSnapshot | null {
  return freshActiveSnapshot(loadActiveTaskSnapshotAt(db, files, tenantId, key), opts);
}

function clearActiveTaskSnapshotAt(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  tenantId: string,
  clearedStatus: string = 'cleared',
): boolean {
  assertTenantId('clearActiveTaskSnapshot', tenantId);
  assertKeyedOnSharedStore('clearActiveTaskSnapshot', hippoRoot, undefined);
  const now = new Date().toISOString();
  // SAFETY: active's shape matches the single `id` column selected above.
  const active = db
    .prepare(
      `SELECT id FROM task_snapshots WHERE status = 'active' AND tenant_id = ? ORDER BY updated_at DESC, id DESC ` +
        `LIMIT 1`,
    )
    .get(tenantId) as { id?: number } | undefined;
  if (!active?.id) {
    removeActiveTaskMirror(hippoRoot, tenantId);
    return false;
  }

  db.prepare(`UPDATE task_snapshots SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`).run(
    clearedStatus,
    now,
    active.id,
    tenantId,
  );
  removeActiveTaskMirror(hippoRoot, tenantId);
  return true;
}

/** Close the `active` task snapshot(s) owned by `sessionId` at session end; the WHERE scopes on `session_id` too so an
 * ending session can never close a newer session's snapshot. Returns the number of rows closed. */
function closeTaskSnapshotsForSessionAt(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  status: string = 'session-ended',
  key?: ContinuityKey,
): number {
  assertTenantId('closeTaskSnapshotsForSession', tenantId);
  if (key) continuityStamp(key);
  // a partial key is a caller bug, so fail loud rather than close nothing
  const owned = key ? continuityWhere(key) : null;
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE task_snapshots SET status = ?, updated_at = ? WHERE status = 'active' AND tenant_id = ? AND ` +
        `session_id = ?${owned ? ` AND ${owned.sql}` : ''}`,
    )
    .run(status, now, tenantId, sessionId, ...(owned?.params ?? []));
  return Number(result.changes ?? 0);
}

function insertSessionEventRow(db: DatabaseSyncLike, tenantId: string, event: SessionEventInput, now: string): number {
  const result = db
    .prepare(
      `
      INSERT INTO session_events(session_id, task, event_type, content, source, scope, metadata_json, tenant_id,
      created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
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
  return Number(result.lastInsertRowid ?? 0);
}

function reloadSessionEvent(db: DatabaseSyncLike, id: number): SessionEvent {
  // SAFETY: row's shape matches the nine columns named in the SELECT below.
  const row = db
    .prepare(`
      SELECT id, session_id, task, event_type, content, source, scope, metadata_json, created_at
      FROM session_events
      WHERE id = ?
    `)
    .get(id) as SessionEventRow | undefined;

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
  // SAFETY: recentRows' shape matches the nine columns named in the SELECT below.
  const recentRows = db
    .prepare(
      `
      SELECT id, session_id, task, event_type, content, source, scope, metadata_json, created_at
      FROM session_events
      WHERE session_id = ? AND tenant_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    )
    .all(sessionId, tenantId, limit) as SessionEventRow[];
  return recentRows.map(rowToSessionEvent).reverse();
}

export function appendSessionEventAt(
  db: DatabaseSyncLike,
  { hippoRoot }: StoreFiles,
  tenantId: string,
  event: SessionEventInput,
): SessionEvent {
  assertTenantId('appendSessionEvent', tenantId);
  const now = new Date().toISOString();

  // Scope is stored as given; default-deny in api.recall + cmdRecall
  // continuity reads applies to slack:private:* and 'unknown:legacy' rows.
  const loaded = reloadSessionEvent(db, insertSessionEventRow(db, tenantId, event, now));
  const recent = recentSessionEventsOldestFirst(db, tenantId, loaded.session_id, 20);
  writeRecentSessionMirror(hippoRoot, tenantId, recent);
  return loaded;
}

export function listSessionEventsAt(
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

  const limit = Math.max(1, Math.trunc(options.limit ?? 8));
  params.push(limit);

  const where = `WHERE ${clauses.join(' AND ')}`;
  // SAFETY: rows' shape matches the nine columns named in the SELECT
  // above.
  const rows = db
    .prepare(`
    SELECT id, session_id, task, event_type, content, source, scope, metadata_json, created_at
    FROM session_events
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
    .all(...params) as SessionEventRow[];

  return rows.map(rowToSessionEvent).reverse();
}

/** Session_ids with a `session_complete` event newer than `sinceMs`; bounds the sleep auto-promotion scan to a fixed
 * window. */
export function findPromotableSessionsAt(
  db: DatabaseSyncLike,
  tenantId: string,
  sinceMs: number,
): Array<{ session_id: string }> {
  assertTenantId('findPromotableSessions', tenantId);
  // SAFETY: rows' shape matches the single `session_id` column selected
  // above.
  const rows = db
    .prepare(`
    SELECT DISTINCT session_id FROM session_events
    WHERE event_type = 'session_complete' AND created_at >= ? AND tenant_id = ?
  `)
    .all(new Date(sinceMs).toISOString(), tenantId) as { session_id: string }[];
  return rows;
}

/** Idempotency guard: true if a trace-layer memory with this source_session_id already exists. */
export function traceExistsForSessionAt(db: DatabaseSyncLike, tenantId: string, session_id: string): boolean {
  assertTenantId('traceExistsForSession', tenantId);
  const row = db
    .prepare(`
    SELECT 1 FROM memories
    WHERE source_session_id = ? AND layer = 'trace' AND tenant_id = ?
    LIMIT 1
  `)
    .get(session_id, tenantId);
  return !!row;
}

/** The owner a session id is bound to, or null. */
function selectSessionOwnerAt(db: DatabaseSyncLike, tenantId: string, sessionId: string): string | null {
  // SAFETY: the SELECT names exactly this one TEXT column.
  const row = db
    .prepare(`SELECT owner_subject FROM session_owners WHERE tenant_id = ? AND session_id = ?`)
    .get(tenantId, sessionId) as { owner_subject: string } | undefined;
  return row?.owner_subject ?? null;
}

/** Binds `sessionId` to `owner` unless a binding exists; the count is 1 when this call bound it. */
function insertSessionOwnerAt(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  owner: string,
  createdAt: string,
): number {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO session_owners(tenant_id, session_id, owner_subject, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(tenantId, sessionId, owner, createdAt);
  return Number(result.changes ?? 0);
}

// SHORTCUT: no created_at index, so each first bind scans the table; add one past a few hundred thousand rows.
/** Drops bindings created before `cutoffIso`. */
function deleteSessionOwnersBeforeAt(db: DatabaseSyncLike, cutoffIso: string): void {
  db.prepare(`DELETE FROM session_owners WHERE created_at < ?`).run(cutoffIso);
}

/** One caller's claim on a session id. */
interface SessionOwnerBinding {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly owner: string;
  /** Bindings older than this are pruned in the write that adds a new one. */
  readonly retentionMs: number;
}

/** Binds under the write lock and returns the stored owner, which is not `owner` when a concurrent first bind won. */
function insertSessionOwner(db: DatabaseSyncLike, binding: SessionOwnerBinding): string | null {
  const { tenantId, sessionId, owner, retentionMs } = binding;
  withWriteScope(
    db,
    'bind_session_owner',
    () => {
      const bound = insertSessionOwnerAt(db, tenantId, sessionId, owner, new Date().toISOString());
      // An older binary supersedes across owners, so the first binding shuts it out in the same transaction.
      if (bound === 1) raiseMinBinary(db, TASK_OWNER_MIN_BINARY);
      // Pruned on write, as the failure log is; a pruned session id is a UUID no other caller knows.
      deleteSessionOwnersBeforeAt(db, new Date(Date.now() - retentionMs).toISOString());
    },
    { busyWaitMs: scopedBusyWait() ?? HOOK_DB_WAIT_MS },
  );
  // Re-read, since a concurrent first bind may have won the INSERT OR IGNORE.
  return selectSessionOwnerAt(db, tenantId, sessionId);
}

/** The owner stored for the session id, binding `binding.owner` first when none is stored. */
function sessionOwnerOrBindAt(db: DatabaseSyncLike, binding: SessionOwnerBinding): string | null {
  // A bound session is the common case after the first prompt, so it must not take the write lock.
  return selectSessionOwnerAt(db, binding.tenantId, binding.sessionId) ?? insertSessionOwner(db, binding);
}

/** Working Memory: bounded buffer for current-state notes, separate from long-term memory; scoped, importance-ranked,
 * evicted past WM_MAX_ENTRIES per scope. */

const WM_MAX_ENTRIES = 20;

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
  let metadata: JsonObject = {};
  try {
    // SAFETY: metadata_json is always written by wmPush via JSON.stringify(opts.metadata ?? {}), so a successful parse
    // yields a plain JSON object; malformed content falls through to the catch below.
    metadata = JSON.parse(row.metadata_json) as JsonObject;
  } catch {
    // The item still lists with its content; only its metadata reads as empty.
    warnDamagedColumn({ table: 'working_memory', id: row.id, column: 'metadata_json' }, 'not valid JSON');
  }
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

/** Push a new entry into working memory; past WM_MAX_ENTRIES the scope's lowest-importance entry is evicted (ties:
 * oldest created_at). Returns the new row ID. */
function wmPushAt(
  db: DatabaseSyncLike,
  opts: {
    scope: string;
    content: string;
    importance?: number;
    sessionId?: string;
    taskId?: string;
    metadata?: JsonObject;
    tenantId?: string;
  },
): number {
  const now = new Date().toISOString();
  const importance = opts.importance ?? 0;
  const tenantId = opts.tenantId ?? resolveTenantId({});

  return withWriteScope(db, 'wm_push', () => {
    const result = db
      .prepare(
        `
      INSERT INTO working_memory(scope, session_id, task_id, importance, content, metadata_json, created_at,
      updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        opts.scope,
        opts.sessionId ?? null,
        opts.taskId ?? null,
        importance,
        opts.content,
        JSON.stringify(opts.metadata ?? {}),
        now,
        now,
        tenantId,
      );

    const id = Number(result.lastInsertRowid ?? 0);

    evictOverCapacity(db, opts.scope, tenantId);

    return id;
  });
}

function evictOverCapacity(db: DatabaseSyncLike, scope: string, tenantId: string): void {
  // Evict if over capacity for this scope.
  // SAFETY: `COUNT(*) AS cnt` always returns exactly one row { cnt }, so `.get()` never yields undefined.
  const countRow = db
    .prepare(`
    SELECT COUNT(*) AS cnt FROM working_memory WHERE scope = ? AND tenant_id = ?
  `)
    .get(scope, tenantId) as { cnt: number } | undefined;

  const count = Number(countRow?.cnt ?? 0);
  if (count > WM_MAX_ENTRIES) {
    const excess = count - WM_MAX_ENTRIES;
    db.prepare(`
      DELETE FROM working_memory
      WHERE id IN (
        SELECT id FROM working_memory
        WHERE scope = ? AND tenant_id = ?
        ORDER BY importance ASC, created_at ASC
        LIMIT ?
      )
    `).run(scope, tenantId, excess);
  }
}

/** Read working memory entries, sorted by importance DESC. */
function wmReadAt(
  db: DatabaseSyncLike,
  opts?: {
    scope?: string;
    sessionId?: string;
    limit?: number;
    tenantId?: string;
  },
): WorkingMemoryItem[] {
  const clauses: string[] = ['tenant_id = ?'];
  const params: Array<string | number> = [opts?.tenantId ?? resolveTenantId({})];

  if (opts?.scope) {
    clauses.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts?.sessionId) {
    clauses.push('session_id = ?');
    params.push(opts.sessionId);
  }

  const limit = Math.max(1, Math.trunc(opts?.limit ?? WM_MAX_ENTRIES));
  params.push(limit);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  // SAFETY: query selects exactly the columns of WorkingMemoryRow, in the
  // same names, from the working_memory table this module owns.
  const rows = db
    .prepare(`
    SELECT id, scope, session_id, task_id, importance, content, metadata_json, created_at, updated_at
    FROM working_memory
    ${where}
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `)
    .all(...params) as WorkingMemoryRow[];

  return rows.map(rowToItem);
}

/** Clear (delete) working memory entries. Returns the count deleted. */
function wmClearAt(
  db: DatabaseSyncLike,
  opts?: {
    scope?: string;
    sessionId?: string;
    tenantId?: string;
  },
): number {
  const clauses: string[] = ['tenant_id = ?'];
  const params: Array<string | number> = [opts?.tenantId ?? resolveTenantId({})];

  if (opts?.scope) {
    clauses.push('scope = ?');
    params.push(opts.scope);
  }
  if (opts?.sessionId) {
    clauses.push('session_id = ?');
    params.push(opts.sessionId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = db.prepare(`DELETE FROM working_memory ${where}`).run(...params);
  return Number(result.changes ?? 0);
}

export function sqliteSessions(on: OnHandle): Sync<Sessions> {
  return {
    saveSnapshot: (tenantId, snapshot, key) =>
      on((db, files) => saveActiveTaskSnapshotAt(db, files, tenantId, snapshot, key ?? undefined), openStore),
    loadSnapshot: (tenantId, key) =>
      on((db, files) => loadActiveTaskSnapshotAt(db, files, tenantId, key ?? undefined), openStore),
    loadFreshSnapshot: (tenantId, opts, key) =>
      on((db, files) => loadFreshActiveTaskSnapshotAt(db, files, tenantId, opts, key ?? undefined), openStore),
    clearSnapshot: (tenantId, clearedStatus) =>
      on((db, files) => clearActiveTaskSnapshotAt(db, files, tenantId, clearedStatus), openStore),
    closeSessionSnapshots: (tenantId, sessionId, status, key) =>
      on((db) => closeTaskSnapshotsForSessionAt(db, tenantId, sessionId, status, key ?? undefined), openStore),
    appendEvent: (tenantId, event) => on((db, files) => appendSessionEventAt(db, files, tenantId, event), openStore),
    listEvents: (tenantId, { sessionId, task, limit }) =>
      on((db) => listSessionEventsAt(db, tenantId, { session_id: sessionId, task, limit }), openStore),
    saveHandoff: (tenantId, handoff, key) =>
      on((db) => saveSessionHandoffAt(db, tenantId, handoff, key ?? undefined), openStore),
    latestHandoff: (tenantId, sessionId, filter, key) =>
      on((db) => loadLatestHandoffAt(db, tenantId, sessionId ?? undefined, filter, key ?? undefined), openStore),
    handoffById: (tenantId, id) => on((db) => loadHandoffByIdAt(db, tenantId, id), openStore),
    stampHandoffOutcome: (tenantId, sessionId, outcome) =>
      on((db) => stampHandoffOutcomeAt(db, tenantId, sessionId, outcome), openStore),
    writeSessionEndHandoff: (tenantId, request) =>
      on((db, files) => writeSessionEndHandoffAt(db, files, { ...request, tenantId }), openStore),
    pushWorkingMemory: (tenantId, item) => on((db) => wmPushAt(db, { ...item, tenantId }), openStore),
    readWorkingMemory: (tenantId, filter) => on((db) => wmReadAt(db, { ...filter, tenantId }), openStore),
    clearWorkingMemory: (tenantId, filter) => on((db) => wmClearAt(db, { ...filter, tenantId }), openStore),
    bindSessionOwner: (tenantId, sessionId, owner, retentionMs) =>
      on((db) => sessionOwnerOrBindAt(db, { tenantId, sessionId, owner, retentionMs })),
  };
}
