import { DEFAULT_TENANT_ID } from '../util/env.js';
import { BadRequestError, NotFoundError } from '../core/api-errors.js';
import type { DatabaseSyncLike } from '../db/index.js';
import { isFtsAvailable, withWriteScope } from '../db/index.js';
import { appendAuditEvent, reportAuditWriteFailure } from './audit.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';

export interface ArchiveOpts {
  reason: string;
  who: string;
  /** Hook run inside the archive SAVEPOINT after the audit row and before RELEASE (the Slack deletion connector marks the event seen atomically);
   * throwing rolls back the whole archive, audit row included. */
  afterArchive?: (db: DatabaseSyncLike, archivedMemoryId: string) => void;
}

/** The subset of `memories` columns this function reads off a `SELECT *` row. */
interface ArchivedMemoryRow {
  kind: string;
  tenant_id: string | null;
  dag_parent_id: string | null;
}

/** Stamps the archived copy of `memoryId` as having its markdown mirror cleaned at `at`. */
export function markMirrorCleaned(db: DatabaseSyncLike, memoryId: string, at: string): void {
  db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(at, memoryId);
}

function loadRawRow(db: DatabaseSyncLike, id: string): ArchivedMemoryRow {
  // SAFETY: SELECT * returns every memories column; only kind, tenant_id and dag_parent_id are read below, all guaranteed present (possibly null) by the
  // schema.
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
  // GDPR: raw_archive stores ONLY metadata, never the original content; the archive_raw audit row is the compliance trail,
  // so the content is unrecoverable from here on.
  const archivedAt = new Date().toISOString();
  const redactedPayload = JSON.stringify({
    redacted: true,
    archived_at: archivedAt,
    tenant_id: row.tenant_id ?? DEFAULT_TENANT_ID,
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

// Emit the archive_raw audit inside the SAVEPOINT so it commits atomically with the row deletion, attributed to the row's own tenant_id,
// not whatever HIPPO_TENANT the calling shell has set.
function auditArchive(db: DatabaseSyncLike, id: string, row: ArchivedMemoryRow, opts: ArchiveOpts): void {
  try {
    appendAuditEvent(db, {
      tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
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

/** The only way to remove a `kind='raw'` row: snapshots it into `raw_archive`, flips `kind` to 'archived' so the append-only trigger allows the delete,
 * all in one write scope that nests in an outer transaction. Throws if the row is missing or not raw; returns the archived_at. */
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
        String(row.tenant_id ?? DEFAULT_TENANT_ID),
        opts.who || 'cli',
      );
    }
    // afterArchive hook: connector idempotency markers (e.g. slack_event_log) must commit atomically with the archive, so it runs INSIDE the SAVEPOINT;
    // throwing rolls back both.
    if (opts.afterArchive) {
      opts.afterArchive(db, id);
    }
    return archivedAt;
  });
}
