import { BadRequestError, NotFoundError } from '../api-errors.js';
import type { DatabaseSyncLike } from '../db.js';
import { isFtsAvailable, withWriteScope } from '../db.js';
import { appendAuditEvent, reportAuditWriteFailure } from './audit.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';

export interface ArchiveOpts {
  reason: string;
  who: string;
  /**
   * Optional hook invoked inside the same SAVEPOINT as the archive INSERT/DELETE,
   * after the audit row is appended and before RELEASE. Used by the Slack
   * deletion connector to mark the deletion event seen atomically — a crash
   * mid-archive must not leave the deletion event untracked. Throwing rolls
   * back the entire archive (including the audit row).
   */
  afterArchive?: (db: DatabaseSyncLike, archivedMemoryId: string) => void;
}

/** The subset of `memories` columns this function reads off a `SELECT *` row. */
interface ArchivedMemoryRow {
  kind: string;
  tenant_id: string | null;
  dag_parent_id: string | null;
}

function loadRawRow(db: DatabaseSyncLike, id: string): ArchivedMemoryRow {
  // SAFETY: SELECT * FROM memories returns every column of the memories table; only
  // kind, tenant_id, and dag_parent_id are read below, all guaranteed present (possibly
  // null) by the memories schema.
  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as
    | ArchivedMemoryRow
    | undefined;
  if (!row) throw new NotFoundError(`memory not found: ${id}`);
  if (row.kind !== 'raw') {
    throw new BadRequestError(`memory ${id} is not raw (kind=${String(row.kind)})`);
  }
  return row;
}

function moveRowToArchive(db: DatabaseSyncLike, id: string, row: ArchivedMemoryRow, opts: ArchiveOpts): string {
  // GDPR: raw_archive stores ONLY metadata, not the original
  // memory content. The audit_log row appended below carries op='archive_raw'
  // for the compliance audit trail. True right-to-be-forgotten — the original
  // content is unrecoverable from raw_archive after this point.
  const archivedAt = new Date().toISOString();
  const redactedPayload = JSON.stringify({
    redacted: true,
    archived_at: archivedAt,
    tenant_id: row.tenant_id ?? 'default',
    kind: row.kind,
    reason: opts.reason,
  });
  db.prepare(
    `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, archivedAt, opts.reason, opts.who, redactedPayload);
  // Flip kind to 'archived' so the BEFORE DELETE trigger no longer fires, then delete.
  db.prepare(`UPDATE memories SET kind = 'archived' WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  // Archived text must be unsearchable at commit, so a failed purge fails (and rolls back) the whole archive.
  if (isFtsAvailable(db)) db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(id);
  return archivedAt;
}

// Emit the archive_raw audit event inside the SAVEPOINT so the audit row is
// committed atomically with the row deletion. Use the row's own tenant_id
// (fetched above as part of SELECT *), not the env. Archives must be
// attributed to the tenant that owns the row, not whatever HIPPO_TENANT
// happens to be set to in the calling shell.
function auditArchive(db: DatabaseSyncLike, id: string, row: ArchivedMemoryRow, opts: ArchiveOpts): void {
  try {
    appendAuditEvent(db, {
      tenantId: String(row.tenant_id ?? 'default'),
      actor: opts.who || 'cli',
      op: 'archive_raw',
      targetId: id,
      metadata: { reason: opts.reason },
    });
  } catch (error) {
    // The archive itself has already succeeded; an unwritable audit table must not undo it.
    reportAuditWriteFailure('archive_raw', String(error), id);
  }
}

/**
 * The only legitimate path to remove a `kind='raw'` row from `memories`.
 *
 * Snapshots the full row into `raw_archive`, flips `kind` to `'archived'` so the
 * append-only trigger lets the delete through, then deletes the row. All in one
 * write scope, which nests inside an outer transaction (e.g. batchWriteAndDelete).
 *
 * Throws if the row does not exist or is not `kind='raw'`. Returns the archived_at it wrote.
 */
export function archiveRawMemory(db: DatabaseSyncLike, id: string, opts: ArchiveOpts): string {
  const row = loadRawRow(db, id);

  // A SAVEPOINT when already inside a transaction (e.g. batchWriteAndDelete), so a throw here
  // rolls back only this archive.
  return withWriteScope(db, 'archive_raw', () => {
    const archivedAt = moveRowToArchive(db, id, row, opts);
    auditArchive(db, id, row, opts);
    // Archiving a child under a level-2 summary marks the parent dirty, inside the
    // SAVEPOINT so the dirty-mark commits atomically with the archive.
    if (row.dag_parent_id) {
      markSummaryDirtyInTx(
        db,
        String(row.dag_parent_id),
        String(row.tenant_id ?? 'default'),
        opts.who || 'cli',
      );
    }
    // afterArchive hook: connector-level idempotency markers
    // (e.g. slack_event_log) must commit atomically with the archive itself.
    // Throwing here rolls back the entire SAVEPOINT — both the archive and any
    // hook side effects. The hook runs INSIDE the SAVEPOINT so its writes
    // share the archive's transactional fate.
    if (opts.afterArchive) {
      opts.afterArchive(db, id);
    }
    return archivedAt;
  });
}
