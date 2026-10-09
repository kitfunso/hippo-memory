// Save, close, load-by-id and list for every typed object. Close and the reads run on a handle the caller opened;
// save opens through `writeEntry`, so the mirror memory and the object row commit as one write.
// Callers check the tenant, the fields and the list status first, so a bad request fails before a database opens.

import { BadRequestError, ConflictError, NotFoundError } from '../api-errors.js';
import { appendAuditEvent } from '../audit.js';
import { withWriteScope } from '../db/busy.js';
import type { DatabaseSyncLike } from '../db.js';
import { removeGraphEntitiesForObject } from '../store/graph-writes.js';
import { markGraphDirty } from '../store/graph-queue.js';
import { objectHalfLifeDays } from '../half-life-migration.js';
import { keysetAfter } from '../keyset.js';
import { createMemory, Layer, type MemoryEntry } from '../memory.js';
import { writeEntry } from '../store/entry-writes.js';
import type { JsonObject } from '../working-memory.js';
import type { BaseObject, ColumnValue, ObjectDescriptor, ObjectListOpts, ObjectSave, ObjectWrite, SavableDescriptor } from './descriptor.js';

function selectRow<O extends BaseObject, R, F extends string>(
  db: DatabaseSyncLike,
  d: ObjectDescriptor<O, R, F>,
  tenantId: string,
  id: number,
): R | undefined {
  return db.prepare(`SELECT ${d.cols} FROM ${d.table} WHERE id = ? AND tenant_id = ?`).get<R | undefined>(id, tenantId);
}

export function loadObjectByIdOn<O extends BaseObject, R, F extends string>(
  db: DatabaseSyncLike,
  d: ObjectDescriptor<O, R, F>,
  tenantId: string,
  id: number,
): O | null {
  const row = selectRow(db, d, tenantId, id);
  return row ? d.rowTo(row) : null;
}

/** Retires one object. The status guard sits in the UPDATE, so zero rows changed means missing or not closable; the reread tells which. */
export function closeObjectOn<O extends BaseObject, R, F extends string>(
  db: DatabaseSyncLike,
  d: ObjectDescriptor<O, R, F>,
  tenantId: string,
  id: number,
  w: ObjectWrite,
): O {
  return withWriteScope(db, 'close_object', () => {
    const marks = d.closableFrom.map(() => '?').join(', ');
    const updated = db.prepare(
      `UPDATE ${d.table} SET status = 'closed', closed_at = ? WHERE id = ? AND tenant_id = ? AND status IN (${marks})`,
    ).run(w.now, id, tenantId, ...d.closableFrom);
    if (updated.changes === 0) {
      const existing = db.prepare(`SELECT status FROM ${d.table} WHERE id = ? AND tenant_id = ?`)
        .get<{ status: string } | undefined>(id, tenantId);
      if (!existing) throw new NotFoundError(`${d.fn.close}: ${d.label} ${id} not found for tenant ${tenantId}`);
      const closable = d.closableFrom.join(' or ');
      throw new ConflictError(
        `${d.fn.close}: ${d.label} ${id} is ${d.closeRefusal ?? `not ${closable}`} (status='${existing.status}'); only ${closable} ${d.plural} can be closed.`,
      );
    }
    const row = selectRow(db, d, tenantId, id);
    if (!row) throw new NotFoundError(`${d.fn.close}: ${d.label} ${id} not found after UPDATE`);
    appendAuditEvent(db, {
      tenantId,
      actor: w.actor,
      op: d.ops.close,
      targetId: String(id),
      metadata: { [d.idKey]: id },
    });
    return d.rowTo(row);
  });
}

/** Run after the close commits: the graph write takes its own write lock. The rows go at once because the rebuild queue is keyed by a mirror memory that may be gone. */
export function dropClosedObjectFromGraph<O extends BaseObject, R, F extends string>(
  hippoRoot: string,
  d: ObjectDescriptor<O, R, F>,
  tenantId: string,
  closed: O,
): void {
  if (!d.graphType) return;
  removeGraphEntitiesForObject(hippoRoot, tenantId, d.graphType, closed.id);
  markGraphDirty(hippoRoot, tenantId, closed.memoryId);
}

export function assertObjectStatus<O extends BaseObject, R, F extends string>(
  d: ObjectDescriptor<O, R, F>,
  status: O['status'] | undefined,
): void {
  if (status && !d.states.has(status)) {
    throw new BadRequestError(`${d.fn.list}: status must be one of ${Array.from(d.states).join('|')}; got ${status}`);
  }
}

/** Newest first. An empty status or filter lists every row, as an absent one does. */
export function loadObjectsOn<O extends BaseObject, R, F extends string>(
  db: DatabaseSyncLike,
  d: ObjectDescriptor<O, R, F>,
  tenantId: string,
  opts: ObjectListOpts<O, NoInfer<F>>,
): O[] {
  const clauses = ['tenant_id = ?'];
  const params: Array<string | number> = [tenantId];
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  for (const key in d.listFilters) {
    const value = opts[key];
    if (value) {
      clauses.push(`${d.listFilters[key]} = ?`);
      params.push(value);
    }
  }
  const after = keysetAfter('created_at', 'id', opts.after);
  // SAFETY: the SELECT names d.cols, the columns R declares, whatever the WHERE clause holds.
  const rows = db.prepare(`
    SELECT ${d.cols} FROM ${d.table}
    WHERE ${clauses.join(' AND ')}${after.sql}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params, ...after.params, opts.limit ?? 100) as R[];
  return rows.map((row) => d.rowTo(row));
}

/** The memory a typed object writes beside its row, so recall finds the object. */
export function objectMirrorMemory(
  hippoRoot: string,
  tenantId: string,
  source: string,
  content: string,
  tags: readonly string[],
): MemoryEntry {
  return createMemory(content, {
    tags: [source, ...tags],
    layer: Layer.Semantic,
    confidence: 'verified',
    source,
    baseHalfLifeDays: objectHalfLifeDays(hippoRoot),
    tenantId,
  });
}

interface NewRow<W> {
  readonly tenantId: string;
  readonly memoryId: string;
  readonly save: ObjectSave<W>;
  readonly version: number;
}

/** Runs before the INSERT, so the new row's id can never be the id it replaces. Returns the successor's version. */
function preflightSupersede<O extends BaseObject, R, F extends string, W>(
  db: DatabaseSyncLike,
  d: SavableDescriptor<O, R, F, W>,
  tenantId: string,
  replaced: number,
): number {
  const pred = db.prepare(
    `SELECT status, ${d.versioned ? 'version' : '0 AS version'} FROM ${d.table} WHERE id = ? AND tenant_id = ?`,
  ).get<{ status: string; version: number } | undefined>(replaced, tenantId);
  if (!pred) {
    throw new NotFoundError(`${d.fn.save}: ${d.label} ${replaced} to supersede not found for tenant ${tenantId}`);
  }
  if (pred.status !== 'active') {
    throw new ConflictError(
      `${d.fn.save}: ${d.label} ${replaced} is not active (status='${pred.status}'); only active ${d.plural} can be superseded.`,
    );
  }
  return pred.version + 1;
}

function insertRow<O extends BaseObject, R, F extends string, W>(
  db: DatabaseSyncLike,
  d: SavableDescriptor<O, R, F, W>,
  row: NewRow<W>,
): number {
  const cols = ['memory_id', 'tenant_id', ...d.columns];
  const values: ColumnValue[] = [row.memoryId, row.tenantId, ...d.values(row.save.fields)];
  if (d.versioned) {
    cols.push('version', 'change_summary');
    values.push(row.version, row.save.supersedesId === undefined ? null : row.save.changeSummary ?? null);
  }
  const result = db.prepare(`
    INSERT INTO ${d.table}(${cols.join(', ')}, status, superseded_by, superseded_at, closed_at, created_at)
    VALUES (${cols.map(() => '?').join(', ')}, 'active', NULL, NULL, NULL, ?)
  `).run(...values, row.save.now);
  return Number(result.lastInsertRowid ?? 0);
}

/** The status guard sits in the UPDATE, so a row another writer retired since the preflight fails the whole save. */
function supersedeRow<O extends BaseObject, R, F extends string, W>(
  db: DatabaseSyncLike,
  d: SavableDescriptor<O, R, F, W>,
  row: NewRow<W>,
  replaced: number,
  id: number,
): void {
  const updated = db.prepare(`
    UPDATE ${d.table}
    SET status = 'superseded', superseded_by = ?, superseded_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'active' AND id != ?
  `).run(id, row.save.now, replaced, row.tenantId, id);
  if (updated.changes === 0) {
    throw new ConflictError(
      `${d.fn.save}: ${d.label} ${replaced} could not be superseded (no longer active or self-reference).`,
    );
  }
  const own: JsonObject = d.versioned
    ? { [d.idKey]: replaced, superseded_by: id, new_version: row.version }
    : { [d.idKey]: replaced, superseded_by: id };
  appendAuditEvent(db, {
    tenantId: row.tenantId,
    actor: row.save.actor,
    op: d.ops.supersede,
    targetId: String(replaced),
    metadata: { ...own, ...d.supersedeMeta?.(row.save.fields) },
  });
}

/** The object half of a save, inside the write that holds the mirror memory: a throw here leaves no row, memory or audit event. */
function writeObjectRow<O extends BaseObject, R, F extends string, W>(
  db: DatabaseSyncLike,
  d: SavableDescriptor<O, R, F, W>,
  tenantId: string,
  memoryId: string,
  s: ObjectSave<W>,
): R {
  const replaced = s.supersedesId;
  const version = replaced === undefined ? 1 : preflightSupersede(db, d, tenantId, replaced);
  const row: NewRow<W> = { tenantId, memoryId, save: s, version };
  const id = insertRow(db, d, row);
  if (replaced !== undefined) supersedeRow(db, d, row, replaced, id);
  const saved = selectRow(db, d, tenantId, id);
  if (!saved) throw new Error(`${d.fn.save}: failed to reload saved ${d.label} row`);
  appendAuditEvent(db, {
    tenantId,
    actor: s.actor,
    op: d.ops.create,
    targetId: String(id),
    metadata: { [d.idKey]: id, ...d.createMeta(s.fields, version) },
  });
  return saved;
}

/** Creates an object, or the version that replaces `s.supersedesId`, with its mirror memory in one write. */
export function saveObject<O extends BaseObject, R, F extends string, W>(
  hippoRoot: string,
  d: SavableDescriptor<O, R, F, W>,
  tenantId: string,
  s: ObjectSave<W>,
): O {
  const mem = objectMirrorMemory(hippoRoot, tenantId, d.source, s.content, s.tags);
  let saved: R | undefined;
  writeEntry(hippoRoot, mem, {
    actor: s.actor,
    afterWrite: (db, memoryId) => {
      saved = writeObjectRow(db, d, tenantId, memoryId, s);
    },
    // The graph mark takes its own write lock, so it waits for the commit.
    afterCommit: () => {
      if (d.graphType) markGraphDirty(hippoRoot, tenantId, mem.id);
    },
  });
  if (saved === undefined) throw new Error(`${d.fn.save}: afterWrite did not populate the row`);
  return d.rowTo(saved);
}
