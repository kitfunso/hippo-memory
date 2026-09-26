/** Quarantine tier (CD5, AT3): pending/approved/rejected record for a memory `remember` flagged as untrusted. */

import type { DatabaseSyncLike } from './db.js';
import { appendAuditEvent } from './audit.js';

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
    // SAFETY: this module's own INSERT/UPDATE statements are the only writers of status.
    status: row.status as QuarantineStatus,
    quarantinedAt: row.quarantined_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
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

export function getQuarantineRow(db: DatabaseSyncLike, tenantId: string, memoryId: string): QuarantineRow | null {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM memory_quarantine WHERE tenant_id = ? AND memory_id = ?`)
    .get<QuarantineDbRow>(tenantId, memoryId);
  return row ? fromDbRow(row) : null;
}

export function listQuarantineRows(
  db: DatabaseSyncLike,
  tenantId: string,
  status: QuarantineStatus | 'all' = 'pending',
  limit = 100,
): QuarantineRow[] {
  // A pending row whose memory was deleted (e.g. Slack message_deleted) is dead; keep its history, drop it from the queue.
  const live = status === 'pending'
    ? ' AND EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_quarantine.memory_id AND m.tenant_id = memory_quarantine.tenant_id)'
    : '';
  const rows = status === 'all'
    ? db.prepare(`SELECT ${SELECT_COLUMNS} FROM memory_quarantine WHERE tenant_id = ? ORDER BY quarantined_at DESC LIMIT ?`)
        .all(tenantId, limit)
    : db.prepare(`SELECT ${SELECT_COLUMNS} FROM memory_quarantine WHERE tenant_id = ? AND status = ?${live} ORDER BY quarantined_at DESC LIMIT ?`)
        .all(tenantId, status, limit);
  // SAFETY: both branches select SELECT_COLUMNS, matching QuarantineDbRow's field set.
  return (rows as QuarantineDbRow[]).map(fromDbRow);
}

export function approveQuarantineRow(db: DatabaseSyncLike, tenantId: string, memoryId: string, decidedBy: string): void {
  db.prepare(`UPDATE memory_quarantine SET status = 'approved', decided_at = ?, decided_by = ? WHERE tenant_id = ? AND memory_id = ?`)
    .run(new Date().toISOString(), decidedBy, tenantId, memoryId);
}

export function rejectQuarantineRow(db: DatabaseSyncLike, tenantId: string, memoryId: string, decidedBy: string): void {
  db.prepare(`UPDATE memory_quarantine SET status = 'rejected', decided_at = ?, decided_by = ? WHERE tenant_id = ? AND memory_id = ?`)
    .run(new Date().toISOString(), decidedBy, tenantId, memoryId);
}
