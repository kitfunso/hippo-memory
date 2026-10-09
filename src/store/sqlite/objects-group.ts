// hippo.db's half of the Objects store group: every statement the typed objects run, each call on a handle of its own.
import { appendAuditEvent } from '../audit.js';
import { getMeta, withWriteScopeOr, type DatabaseSyncLike } from '../../db.js';
import { keysetAfter } from '../../keyset.js';
import type { JsonObject } from '../working-memory.js';
import { stampOriginProject, upsertEntryRow } from '../entry-row.js';
import { auditEntryWrite, writeEntryMirrors } from '../entry-writes.js';
import { markGraphDirty } from '../graph-queue.js';
import { removeGraphEntitiesForObject } from '../graph-writes.js';
import type { ObjectByKind, ObjectKind, SavableKind } from '../object-types.js';
import { onHandle, openStore, TYPED_HALF_LIFE_META_KEY } from '../open.js';
import { isObjectRefusal, type ObjectClose, type ObjectListQuery, type ObjectRefusal, type Objects, type ObjectSave } from '../port.js';
import { auditingRefusal } from './entry-writes-group.js';
import { type ColumnValue, insertSpec, rowSpec, type RowByKind } from './object-rows.js';

/** The group with each answer as its value; spelled out because `Sync<Objects>` would widen each method's kind to every kind. */
export interface SyncObjects {
  listObjects<K extends ObjectKind>(tenantId: string, kind: K, query: ObjectListQuery<K>): ObjectByKind[K][];
  objectById<K extends ObjectKind>(tenantId: string, kind: K, id: number): ObjectByKind[K] | null;
  closeObject<K extends ObjectKind>(tenantId: string, kind: K, id: number, close: ObjectClose<K>): ObjectByKind[K] | ObjectRefusal;
  saveObject<K extends SavableKind>(tenantId: string, kind: K, save: ObjectSave<K>): ObjectByKind[K] | ObjectRefusal;
  mirrorsOnDefaultHalfLife(): boolean;
}

export function sqliteObjects(hippoRoot: string): SyncObjects {
  return {
    listObjects: (tenantId, kind, query) => onHandle(hippoRoot, (db) => listRows(db, tenantId, kind, query)),
    objectById(tenantId, kind, id) {
      const row = onHandle(hippoRoot, (db) => selectRow(db, kind, tenantId, id));
      return row ? rowSpec(kind).rowTo(row) : null;
    },
    closeObject: (tenantId, kind, id, close) => closeAt(hippoRoot, tenantId, kind, id, close),
    saveObject: (tenantId, kind, save) => saveAt(hippoRoot, tenantId, kind, save),
    mirrorsOnDefaultHalfLife: () => onHandle(hippoRoot, (db) => getMeta(db, TYPED_HALF_LIFE_META_KEY, '') !== '', openStore),
  };
}

/** The group as a served store answers it: each call runs at once and resolves through a Promise, so a throw rejects as another store's would. */
export function servedObjects(sync: SyncObjects): Objects {
  return {
    listObjects: async (tenantId, kind, query) => sync.listObjects(tenantId, kind, query),
    objectById: async (tenantId, kind, id) => sync.objectById(tenantId, kind, id),
    closeObject: async (tenantId, kind, id, close) => sync.closeObject(tenantId, kind, id, close),
    saveObject: async (tenantId, kind, save) => sync.saveObject(tenantId, kind, save),
    mirrorsOnDefaultHalfLife: async () => sync.mirrorsOnDefaultHalfLife(),
  };
}

/** The newest object in `status` that a memory mirrors, for the CLI flags that name an object by its memory id. */
export function objectIdByMemory<K extends ObjectKind>(hippoRoot: string, tenantId: string, kind: K, status: ObjectByKind[K]['status'], memoryId: string): number | null {
  return onHandle(hippoRoot, (db) => {
    const row = db.prepare(
      `SELECT id FROM ${rowSpec(kind).table} WHERE memory_id = ? AND tenant_id = ? AND status = ? ORDER BY id DESC LIMIT 1`,
    ).get<{ id: number } | undefined>(memoryId, tenantId, status);
    return row ? row.id : null;
  });
}

function selectRow<K extends ObjectKind>(db: DatabaseSyncLike, kind: K, tenantId: string, id: number): RowByKind[K] | undefined {
  const spec = rowSpec(kind);
  return db.prepare(`SELECT ${spec.cols} FROM ${spec.table} WHERE id = ? AND tenant_id = ?`).get<RowByKind[K] | undefined>(id, tenantId);
}

function listRows<K extends ObjectKind>(db: DatabaseSyncLike, tenantId: string, kind: K, query: ObjectListQuery<K>): ObjectByKind[K][] {
  const spec = rowSpec(kind);
  const clauses = ['tenant_id = ?'];
  const params: Array<string | number> = [tenantId];
  if (query.status) {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.filter && spec.filterColumn) {
    clauses.push(`${spec.filterColumn} = ?`);
    params.push(query.filter);
  }
  const after = keysetAfter('created_at', 'id', query.after);
  // SAFETY: the SELECT names spec.cols, the columns the kind's row declares, whatever the WHERE clause holds.
  const rows = db.prepare(`
    SELECT ${spec.cols} FROM ${spec.table}
    WHERE ${clauses.join(' AND ')}${after.sql}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params, ...after.params, query.limit) as RowByKind[K][];
  return rows.map((row) => spec.rowTo(row));
}

/** The status guard sits in the UPDATE, so zero rows changed means missing or not closable; the reread tells which. */
function closeRow<K extends ObjectKind>(db: DatabaseSyncLike, tenantId: string, kind: K, id: number, close: ObjectClose<K>): ObjectByKind[K] | ObjectRefusal {
  const spec = rowSpec(kind);
  return withWriteScopeOr(db, 'close_object', (rollback) => {
    const marks = close.from.map(() => '?').join(', ');
    const updated = db.prepare(
      `UPDATE ${spec.table} SET status = 'closed', closed_at = ? WHERE id = ? AND tenant_id = ? AND status IN (${marks})`,
    ).run(close.at, id, tenantId, ...close.from);
    if (updated.changes === 0) {
      const existing = db.prepare(`SELECT status FROM ${spec.table} WHERE id = ? AND tenant_id = ?`)
        .get<{ status: string } | undefined>(id, tenantId);
      return rollback<ObjectRefusal>(existing ? { refused: 'status', status: existing.status } : { refused: 'missing' });
    }
    const row = selectRow(db, kind, tenantId, id);
    if (!row) return rollback<ObjectRefusal>({ refused: 'vanished' });
    appendAuditEvent(db, { tenantId, actor: close.actor, op: spec.closeOp, targetId: String(id), metadata: { [spec.idKey]: id } });
    return spec.rowTo(row);
  });
}

function closeAt<K extends ObjectKind>(hippoRoot: string, tenantId: string, kind: K, id: number, close: ObjectClose<K>): ObjectByKind[K] | ObjectRefusal {
  const { graphType } = rowSpec(kind);
  return onHandle(hippoRoot, (db) => {
    const closed = closeRow(db, tenantId, kind, id, close);
    if (isObjectRefusal(closed) || !graphType) return closed;
    // Each graph write takes its own write lock, so both wait for the commit. The rows go at once because the rebuild queue is keyed by a mirror memory that may be gone.
    removeGraphEntitiesForObject(hippoRoot, tenantId, graphType, closed.id);
    markGraphDirty(hippoRoot, tenantId, closed.memoryId);
    return closed;
  });
}

interface NewRow<K extends SavableKind> {
  readonly tenantId: string;
  readonly kind: K;
  readonly memoryId: string;
  readonly save: ObjectSave<K>;
  readonly version: number;
}

/** Runs before the INSERT, so the new row's id can never be the id it replaces. */
function successorVersion(db: DatabaseSyncLike, tenantId: string, kind: SavableKind, replaced: number): { version: number } | ObjectRefusal {
  const pred = db.prepare(
    `SELECT status, ${insertSpec(kind).versioned ? 'version' : '0 AS version'} FROM ${rowSpec(kind).table} WHERE id = ? AND tenant_id = ?`,
  ).get<{ status: string; version: number } | undefined>(replaced, tenantId);
  if (!pred) return { refused: 'missing' };
  if (pred.status !== 'active') return { refused: 'status', status: pred.status };
  return { version: pred.version + 1 };
}

function insertRow<K extends SavableKind>(db: DatabaseSyncLike, row: NewRow<K>): number {
  const insert = insertSpec(row.kind);
  const cols = ['memory_id', 'tenant_id', ...insert.columns];
  const values: ColumnValue[] = [row.memoryId, row.tenantId, ...insert.values(row.save.fields)];
  if (insert.versioned) {
    cols.push('version', 'change_summary');
    values.push(row.version, row.save.supersedesId === undefined ? null : row.save.changeSummary ?? null);
  }
  const result = db.prepare(`
    INSERT INTO ${rowSpec(row.kind).table}(${cols.join(', ')}, status, superseded_by, superseded_at, closed_at, created_at)
    VALUES (${cols.map(() => '?').join(', ')}, 'active', NULL, NULL, NULL, ?)
  `).run(...values, row.save.at);
  return Number(result.lastInsertRowid ?? 0);
}

/** The status guard sits in the UPDATE, so a row another writer retired since the preflight fails the whole save; false says so. */
function supersedeRow<K extends SavableKind>(db: DatabaseSyncLike, row: NewRow<K>, replaced: number, id: number): boolean {
  const spec = rowSpec(row.kind);
  const insert = insertSpec(row.kind);
  const updated = db.prepare(`
    UPDATE ${spec.table}
    SET status = 'superseded', superseded_by = ?, superseded_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'active' AND id != ?
  `).run(id, row.save.at, replaced, row.tenantId, id);
  if (updated.changes === 0) return false;
  const own: JsonObject = insert.versioned
    ? { [spec.idKey]: replaced, superseded_by: id, new_version: row.version }
    : { [spec.idKey]: replaced, superseded_by: id };
  appendAuditEvent(db, {
    tenantId: row.tenantId,
    actor: row.save.actor,
    op: insert.supersedeOp,
    targetId: String(replaced),
    metadata: { ...own, ...insert.supersedeMeta?.(row.save.fields) },
  });
  return true;
}

/** The object half of a save, inside the scope that holds the mirror memory: a refusal or a throw here leaves no row, memory or audit event. */
function writeObjectRow<K extends SavableKind>(db: DatabaseSyncLike, tenantId: string, kind: K, memoryId: string, save: ObjectSave<K>): RowByKind[K] | ObjectRefusal {
  const replaced = save.supersedesId;
  const next = replaced === undefined ? { version: 1 } : successorVersion(db, tenantId, kind, replaced);
  if (isObjectRefusal(next)) return next;
  const row: NewRow<K> = { tenantId, kind, memoryId, save, version: next.version };
  const id = insertRow(db, row);
  if (replaced !== undefined && !supersedeRow(db, row, replaced, id)) return { refused: 'raced' };
  const saved = selectRow(db, kind, tenantId, id);
  if (!saved) return { refused: 'vanished' };
  appendAuditEvent(db, {
    tenantId,
    actor: save.actor,
    op: insertSpec(kind).createOp,
    targetId: String(id),
    metadata: { [rowSpec(kind).idKey]: id, ...insertSpec(kind).createMeta(save.fields, next.version) },
  });
  return saved;
}

/** One write scope on one handle holds the mirror, the object row, the successor link and every audit row, the mirror's remember row last. */
function saveAt<K extends SavableKind>(hippoRoot: string, tenantId: string, kind: K, save: ObjectSave<K>): ObjectByKind[K] | ObjectRefusal {
  const spec = rowSpec(kind);
  return onHandle(hippoRoot, (db) => auditingRefusal(db, save.actor, () => {
    const mirror = stampOriginProject(hippoRoot, save.mirror);
    const written = withWriteScopeOr(db, 'write_entry', (rollback) => {
      upsertEntryRow(db, mirror);
      const row = writeObjectRow(db, tenantId, kind, mirror.id, save);
      if (isObjectRefusal(row)) return rollback(row);
      auditEntryWrite(db, mirror, save.actor);
      return row;
    });
    if (isObjectRefusal(written)) return written;
    // The graph mark takes its own write lock, so it waits for the commit.
    if (spec.graphType) markGraphDirty(hippoRoot, tenantId, mirror.id);
    writeEntryMirrors(hippoRoot, mirror);
    return spec.rowTo(written);
  }), openStore);
}
