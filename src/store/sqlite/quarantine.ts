// hippo.db's Quarantine group: the review queue's rows, and the approve and reject writes with their audit rows.
import { appendAuditEvents } from './audit.js';
import { withWriteScopeOr, type DatabaseSyncLike } from '../../db/index.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { keysetAfter } from '../../db/sql.js';
import { selectEntriesByIds, readEntry } from './entry-reads.js';
import type {
  QuarantineApproval,
  QuarantineListQuery,
  QuarantineRefusal,
  QuarantineRejection,
  QuarantinedMemory,
  Quarantine,
} from '../port.js';
import { QUARANTINE_LIST_LIMIT, type QuarantineRow, type QuarantineStatus } from '../port/quarantine.js';
import { QUARANTINE_SCOPE_PREFIX, quarantineScopeFor } from '../../base/scope/recall-scope.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { Handles, StoreFiles } from './open.js';
import { openStore } from './handles.js';
import { bound } from './bound.js';
import { writeEntryMirrorsIn } from './entry-writes.js';
import { cachedStatement } from '../../db/statement-cache.js';

export { QUARANTINE_SCOPE_PREFIX };

// SAFETY: every read cast to this row selects SELECT_COLUMNS; scripts/check-row-casts.mjs proves it.
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
  const row = cachedStatement(
    db,
    `SELECT ${SELECT_COLUMNS} FROM memory_quarantine WHERE tenant_id = ? AND memory_id = ?`,
  ).get(tenantId, memoryId) as QuarantineDbRow | undefined;
  return row ? fromDbRow(row) : null;
}

function listQuarantineRows(
  db: DatabaseSyncLike,
  tenantId: string,
  status: QuarantineStatus | 'all' = 'pending',
  limit = QUARANTINE_LIST_LIMIT,
  afterRow?: KeysetPosition,
): QuarantineRow[] {
  // A pending row whose memory was deleted (e.g. Slack message_deleted) is dead; keep its history, drop it from the
  // queue.
  const live =
    status === 'pending'
      ? ' AND EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_quarantine.memory_id AND m.tenant_id = ' +
        'memory_quarantine.tenant_id)'
      : '';
  const after = keysetAfter('quarantined_at', 'memory_id', afterRow);
  const order = 'ORDER BY quarantined_at DESC, memory_id DESC LIMIT ?';
  const rows =
    status === 'all'
      ? (cachedStatement(
          db,
          `SELECT ${SELECT_COLUMNS} FROM memory_quarantine WHERE tenant_id = ?${after.sql} ${order}`,
        ).all(tenantId, ...after.params, limit) as QuarantineDbRow[])
      : (cachedStatement(
          db,
          `SELECT ${SELECT_COLUMNS} FROM memory_quarantine WHERE tenant_id = ? AND status = ?${live}${after.sql} ` +
            `${order}`,
        ).all(tenantId, status, ...after.params, limit) as QuarantineDbRow[]);
  return rows.map(fromDbRow);
}

interface RecordQuarantineOptions {
  tenantId: string;
  memoryId: string;
  originalScope: string | null;
  reason: string;
  actor: string;
}

/** Insert the quarantine row + its audit event; caller runs this inside the memory's own write transaction. */
export function recordQuarantine(db: DatabaseSyncLike, opts: RecordQuarantineOptions): void {
  cachedStatement(
    db,
    `INSERT INTO memory_quarantine (tenant_id, memory_id, original_scope, reason, status, quarantined_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(opts.tenantId, opts.memoryId, opts.originalScope, opts.reason, new Date().toISOString());
  appendAuditEvents(db, [
    {
      tenantId: opts.tenantId,
      actor: opts.actor,
      op: 'quarantine',
      targetId: opts.memoryId,
      metadata: { reason: opts.reason, originalScope: opts.originalScope },
    },
  ]);
}

function approveQuarantineRow(db: DatabaseSyncLike, tenantId: string, memoryId: string, decidedBy: string): void {
  cachedStatement(
    db,
    `UPDATE memory_quarantine SET status = 'approved', decided_at = ?, decided_by = ? WHERE tenant_id = ? AND ` +
      `memory_id = ?`,
  ).run(new Date().toISOString(), decidedBy, tenantId, memoryId);
}

function rejectQuarantineRow(db: DatabaseSyncLike, tenantId: string, memoryId: string, decidedBy: string): void {
  cachedStatement(
    db,
    `UPDATE memory_quarantine SET status = 'rejected', decided_at = ?, decided_by = ? WHERE tenant_id = ? AND ` +
      `memory_id = ?`,
  ).run(new Date().toISOString(), decidedBy, tenantId, memoryId);
}

/** A page of the tenant's records, each with its memory's content read in the same query batch. */
function listQuarantined(
  db: DatabaseSyncLike,
  tenantId: string,
  { status, limit, after }: QuarantineListQuery,
): QuarantinedMemory[] {
  const rows = listQuarantineRows(db, tenantId, status, limit, after);
  const entries = selectEntriesByIds(
    db,
    rows.map((row) => row.memoryId),
    tenantId,
  );
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
function approveQuarantined(db: DatabaseSyncLike, tenantId: string, id: string, actor: string): QuarantineApproval {
  return withWriteScopeOr<QuarantineApproval, QuarantineApproval>(db, 'quarantine_approve', (rollback) => {
    const row = pendingOrRefusal(db, tenantId, id);
    if ('outcome' in row) return rollback(row);
    const quarantineScope = quarantineScopeFor(row.originalScope);
    const updated = cachedStatement(
      db,
      `UPDATE memories SET scope = ? WHERE id = ? AND tenant_id = ? AND scope = ?`,
    ).run(row.originalScope, id, tenantId, quarantineScope);
    if (Number(updated.changes ?? 0) !== 1) return rollback({ outcome: 'scope_moved' });
    approveQuarantineRow(db, tenantId, id, actor);
    appendAuditEvents(db, [
      {
        tenantId,
        actor,
        op: 'quarantine_approve',
        targetId: id,
        metadata: { originalScope: row.originalScope },
      },
    ]);
    return { outcome: 'approved' };
  });
}

/** Marks the record rejected; the memory row is left as stored. */
function rejectQuarantined(db: DatabaseSyncLike, tenantId: string, id: string, actor: string): QuarantineRejection {
  return withWriteScopeOr<QuarantineRejection, QuarantineRejection>(db, 'quarantine_reject', (rollback) => {
    const row = pendingOrRefusal(db, tenantId, id);
    if ('outcome' in row) return rollback(row);
    rejectQuarantineRow(db, tenantId, id, actor);
    appendAuditEvents(db, [{ tenantId, actor, op: 'quarantine_reject', targetId: id, metadata: {} }]);
    return { outcome: 'rejected' };
  });
}

/** After the commit, best effort: a failed rewrite leaves the markdown mirror showing the quarantine scope, which still
 * hides the memory. */
function rewriteMirror(db: DatabaseSyncLike, files: StoreFiles, tenantId: string, id: string): void {
  try {
    const restored = readEntry(db, id, tenantId);
    if (restored) writeEntryMirrorsIn(files, restored);
  } catch (err) {
    log.error(`quarantine: mirror rewrite failed for ${id}: ${errorMessage(err)}`, errorFields(err));
  }
}

export function sqliteQuarantine({ on, files }: Handles): Quarantine {
  return {
    ...bound<Omit<Quarantine, 'approveQuarantined'>>(on, {
      listQuarantined: listQuarantined,
      rejectQuarantined: rejectQuarantined,
    }),
    ...bound<Pick<Quarantine, 'approveQuarantined'>>(
      on,
      {
        approveQuarantined: (db, tenantId, id, actor) => {
          const result = approveQuarantined(db, tenantId, id, actor);
          if (result.outcome === 'approved') rewriteMirror(db, files, tenantId, id);
          return result;
        },
      },
      openStore,
    ),
  };
}
