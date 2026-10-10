// The memory_quarantine table: the review queue's rows, and the approve and reject writes with their audit rows.
import { appendAuditEvent } from './audit.js';
import { withWriteScopeOr, type DatabaseSyncLike } from '../db/index.js';
import { keysetAfter, type KeysetPosition } from '../util/keyset.js';
import { selectEntriesByIds } from './entry-reads.js';
import type { QuarantineApproval, QuarantineListQuery, QuarantineRefusal, QuarantineRejection, QuarantinedMemory } from './port.js';

export const QUARANTINE_SCOPE_PREFIX = 'quarantine:private:';

/** Scope a quarantined memory is stored under; matches PRIVATE_SCOPE_RE so every default-deny site hides it. */
export function quarantineScopeFor(original: string | null): string {
  return `${QUARANTINE_SCOPE_PREFIX}${original ?? 'unscoped'}`;
}

export function isQuarantineScope(scope: string | null | undefined): boolean {
  return scope != null && scope.startsWith(QUARANTINE_SCOPE_PREFIX);
}

export type QuarantineStatus = 'pending' | 'approved' | 'rejected';

export interface QuarantineRow {
  tenantId: string;
  memoryId: string;
  originalScope: string | null;
  reason: string;
  status: QuarantineStatus;
  quarantinedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

interface QuarantineDbRow {
  tenant_id: string;
  memory_id: string;
  original_scope: string | null;
  reason: string;
  status: string;
  quarantined_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

const SELECT_COLUMNS = 'tenant_id, memory_id, original_scope, reason, status, quarantined_at, decided_at, decided_by';

function fromDbRow(row: QuarantineDbRow): QuarantineRow {
  return {
    tenantId: row.tenant_id,
    memoryId: row.memory_id,
    originalScope: row.original_scope,
    reason: row.reason,
    // SAFETY: the quarantine INSERT and this module's UPDATE statements are the only writers of status.
    status: row.status as QuarantineStatus,
    quarantinedAt: row.quarantined_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

function getQuarantineRow(db: DatabaseSyncLike, tenantId: string, memoryId: string): QuarantineRow | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM memory_quarantine WHERE tenant_id = ? AND memory_id = ?`)
    .get<QuarantineDbRow>(tenantId, memoryId);
  return row ? fromDbRow(row) : null;
}

function listQuarantineRows(
  db: DatabaseSyncLike,
  tenantId: string,
  status: QuarantineStatus | 'all' = 'pending',
  limit = 100,
  afterRow?: KeysetPosition,
): QuarantineRow[] {
  // A pending row whose memory was deleted (e.g. Slack message_deleted) is dead; keep its history, drop it from the queue.
  const live = status === 'pending'
    ? ' AND EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_quarantine.memory_id AND m.tenant_id = memory_quarantine.tenant_id)'
    : '';
  const after = keysetAfter('quarantined_at', 'memory_id', afterRow);
  const order = 'ORDER BY quarantined_at DESC, memory_id DESC LIMIT ?';
  const rows = status === 'all'
    ? db.prepare(`SELECT ${SELECT_COLUMNS} FROM memory_quarantine WHERE tenant_id = ?${after.sql} ${order}`)
        .all(tenantId, ...after.params, limit)
    : db.prepare(`SELECT ${SELECT_COLUMNS} FROM memory_quarantine WHERE tenant_id = ? AND status = ?${live}${after.sql} ${order}`)
        .all(tenantId, status, ...after.params, limit);
  // SAFETY: both branches select SELECT_COLUMNS, matching QuarantineDbRow's field set.
  return (rows as QuarantineDbRow[]).map(fromDbRow);
}

export interface RecordQuarantineOpts {
  tenantId: string;
  memoryId: string;
  originalScope: string | null;
  reason: string;
  actor: string;
}

/** Insert the quarantine row + its audit event; caller runs this inside the memory's own write transaction. */
export function recordQuarantine(db: DatabaseSyncLike, opts: RecordQuarantineOpts): void {
  db.prepare(
    `INSERT INTO memory_quarantine (tenant_id, memory_id, original_scope, reason, status, quarantined_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(opts.tenantId, opts.memoryId, opts.originalScope, opts.reason, new Date().toISOString());
  appendAuditEvent(db, {
    tenantId: opts.tenantId,
    actor: opts.actor,
    op: 'quarantine',
    targetId: opts.memoryId,
    metadata: { reason: opts.reason, originalScope: opts.originalScope },
  });
}

function approveQuarantineRow(db: DatabaseSyncLike, tenantId: string, memoryId: string, decidedBy: string): void {
  db.prepare(`UPDATE memory_quarantine SET status = 'approved', decided_at = ?, decided_by = ? WHERE tenant_id = ? AND memory_id = ?`)
    .run(new Date().toISOString(), decidedBy, tenantId, memoryId);
}

function rejectQuarantineRow(db: DatabaseSyncLike, tenantId: string, memoryId: string, decidedBy: string): void {
  db.prepare(`UPDATE memory_quarantine SET status = 'rejected', decided_at = ?, decided_by = ? WHERE tenant_id = ? AND memory_id = ?`)
    .run(new Date().toISOString(), decidedBy, tenantId, memoryId);
}

/** A page of the tenant's records, each with its memory's content read in the same query batch. */
export function listQuarantinedAt(db: DatabaseSyncLike, tenantId: string, { status, limit, after }: QuarantineListQuery): QuarantinedMemory[] {
  const rows = listQuarantineRows(db, tenantId, status, limit, after);
  const entries = selectEntriesByIds(db, rows.map((row) => row.memoryId), tenantId);
  return rows.map((row) => ({ ...row, content: entries.get(row.memoryId)?.content ?? null }));
}

/** The pending record, or why a decision on `id` is refused. */
function pendingOrRefusal(db: DatabaseSyncLike, tenantId: string, id: string): QuarantineRow | QuarantineRefusal {
  const row = getQuarantineRow(db, tenantId, id);
  if (!row) return { outcome: 'not_quarantined' };
  if (row.status !== 'pending') return { outcome: 'already_decided', status: row.status };
  return row;
}

/** Puts the memory back under its original scope; the scope guard refuses a row moved since it was quarantined. */
export function approveQuarantinedAt(db: DatabaseSyncLike, tenantId: string, id: string, actor: string): QuarantineApproval {
  return withWriteScopeOr<QuarantineApproval, QuarantineApproval>(db, 'quarantine_approve', (rollback) => {
    const row = pendingOrRefusal(db, tenantId, id);
    if ('outcome' in row) return rollback(row);
    const quarantineScope = quarantineScopeFor(row.originalScope);
    const updated = db
      .prepare(`UPDATE memories SET scope = ? WHERE id = ? AND tenant_id = ? AND scope = ?`)
      .run(row.originalScope, id, tenantId, quarantineScope);
    if (Number(updated.changes ?? 0) !== 1) return rollback({ outcome: 'scope_moved' });
    approveQuarantineRow(db, tenantId, id, actor);
    appendAuditEvent(db, { tenantId, actor, op: 'quarantine_approve', targetId: id, metadata: { originalScope: row.originalScope } });
    return { outcome: 'approved' };
  });
}

/** Marks the record rejected; the memory row is left as stored. */
export function rejectQuarantinedAt(db: DatabaseSyncLike, tenantId: string, id: string, actor: string): QuarantineRejection {
  return withWriteScopeOr<QuarantineRejection, QuarantineRejection>(db, 'quarantine_reject', (rollback) => {
    const row = pendingOrRefusal(db, tenantId, id);
    if ('outcome' in row) return rollback(row);
    rejectQuarantineRow(db, tenantId, id, actor);
    appendAuditEvent(db, { tenantId, actor, op: 'quarantine_reject', targetId: id, metadata: {} });
    return { outcome: 'rejected' };
  });
}
