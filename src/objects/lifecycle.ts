// Close, load-by-id and list for every typed object, on a handle the caller opened.
// Callers check the tenant and the list status first, so a bad request fails before a database opens.

import { BadRequestError, ConflictError, NotFoundError } from '../api-errors.js';
import { appendAuditEvent } from '../audit.js';
import { withWriteScope } from '../db/busy.js';
import type { DatabaseSyncLike } from '../db.js';
import { markGraphDirty, removeGraphEntitiesForObject } from '../graph/write.js';
import { keysetAfter } from '../keyset.js';
import type { BaseObject, ObjectDescriptor, ObjectListOpts, ObjectWrite } from './descriptor.js';

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
        `${d.fn.close}: ${d.label} ${id} is not ${closable} (status='${existing.status}'); only ${closable} ${d.plural} can be closed.`,
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
  opts: ObjectListOpts<O, F>,
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
