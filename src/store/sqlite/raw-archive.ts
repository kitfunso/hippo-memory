import { DEFAULT_TENANT_ID } from '../../base/util/tenant.js';
import { BadRequestError, NotFoundError } from '../../base/errors/api-errors.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import { isFtsAvailable, withWriteScope } from '../../db/index.js';
import { appendAuditEvents } from './audit.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { cachedStatement } from '../../db/statement-cache.js';

export interface ArchiveOptions {
  reason: string;
  who: string;
  /** Hook run inside the archive SAVEPOINT after the audit row and before RELEASE (the Slack deletion connector marks
   * the event seen atomically); throwing rolls back the whole archive, audit row included. */
  afterArchive?: (db: DatabaseSyncLike, archivedMemoryId: string) => void;
}

/** The `memories` columns an archive reads. */
interface ArchivedMemoryRow {
  id: string;
  kind: string;
  tenant_id: string | null;
  dag_parent_id: string | null;
}

/** Stamps the archived copy of `memoryId` as having its markdown mirror cleaned at `at`. */
export function markMirrorCleaned(db: DatabaseSyncLike, memoryId: string, at: string): void {
  cachedStatement(db, `UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(at, memoryId);
}

// Every id list binds as one JSON array, so each statement's text is the same for one row or many.
const IDS = 'SELECT value FROM json_each(?)';

/** The rows behind `ids`, in their order; throws for the first one that is missing or not raw. */
function loadRawRows(db: DatabaseSyncLike, ids: readonly string[]): ArchivedMemoryRow[] {
  // SAFETY: the four selected columns are the interface's keys, each a memories column.
  const rows = cachedStatement(db, `SELECT id, kind, tenant_id, dag_parent_id FROM memories WHERE id IN (${IDS})`).all(
    JSON.stringify(ids),
  ) as ArchivedMemoryRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new NotFoundError(`memory not found: ${id}`);
    if (row.kind !== 'raw') throw new BadRequestError(`memory ${id} is not raw (kind=${String(row.kind)})`);
    return row;
  });
}

function moveRowsToArchive(db: DatabaseSyncLike, rows: readonly ArchivedMemoryRow[], opts: ArchiveOptions): string {
  // GDPR: raw_archive stores ONLY metadata, never the original content; the archive_raw audit row is the compliance
  // trail, so the content is unrecoverable from here on.
  const archivedAt = new Date().toISOString();
  const payloads = rows.map((row) => [
    row.id,
    JSON.stringify({
      redacted: true,
      archived_at: archivedAt,
      tenant_id: row.tenant_id ?? DEFAULT_TENANT_ID,
      kind: row.kind,
      reason: opts.reason,
    }),
  ]);
  cachedStatement(
    db,
    `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) ` +
      `SELECT json_extract(value, '$[0]'), ?, ?, ?, json_extract(value, '$[1]') FROM json_each(?) ORDER BY key`,
  ).run(archivedAt, opts.reason, opts.who, JSON.stringify(payloads));
  const ids = JSON.stringify(rows.map((row) => row.id));
  // Flip kind to 'archived' so the BEFORE DELETE trigger no longer fires, then delete.
  cachedStatement(db, `UPDATE memories SET kind = 'archived' WHERE id IN (${IDS})`).run(ids);
  cachedStatement(db, `DELETE FROM memories WHERE id IN (${IDS})`).run(ids);
  // Archived text must be unsearchable at commit, so a failed purge fails (and rolls back) the whole archive.
  if (isFtsAvailable(db)) cachedStatement(db, `DELETE FROM memories_fts WHERE id IN (${IDS})`).run(ids);
  return archivedAt;
}

// Emit the archive_raw audit inside the SAVEPOINT so it commits atomically with the row deletion, attributed to each
// row's own tenant_id, not whatever HIPPO_TENANT the calling shell has set.
function auditArchive(db: DatabaseSyncLike, rows: readonly ArchivedMemoryRow[], opts: ArchiveOptions): void {
  const actor = opts.who || CLI_ACTOR;
  try {
    appendAuditEvents(
      db,
      rows.map((row) => ({
        tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
        actor,
        op: 'archive_raw' as const,
        targetId: row.id,
        metadata: { reason: opts.reason },
      })),
    );
  } catch (error) {
    // The archive itself has already succeeded; an unwritable audit table must not undo it.
    for (const row of rows) reportAuditWriteFailure('archive_raw', error, row.id);
  }
}

// Archiving a child under a level-2 summary marks the parent dirty, inside the SAVEPOINT so the dirty-mark commits
// atomically with the archive.
function markParentsDirty(db: DatabaseSyncLike, rows: readonly ArchivedMemoryRow[], who: string): void {
  const parents = new Map<string, string>();
  for (const row of rows) {
    if (row.dag_parent_id) parents.set(String(row.dag_parent_id), String(row.tenant_id ?? DEFAULT_TENANT_ID));
  }
  for (const [parent, tenant] of parents) markSummaryDirtyInTx(db, parent, tenant, who || CLI_ACTOR);
}

/** archiveRawMemory for every row in `ids` in one write scope, in the same few statements for one row or many; throws,
 * archiving none, if any is missing or not raw. Returns the archived_at. */
export function archiveRawMemories(db: DatabaseSyncLike, ids: readonly string[], opts: ArchiveOptions): string {
  const rows = loadRawRows(db, [...new Set(ids)]);
  // A SAVEPOINT when already inside a transaction (e.g. batchWriteAndDelete), so a throw here rolls back only this
  // archive.
  return withWriteScope(db, 'archive_raw', () => {
    const archivedAt = moveRowsToArchive(db, rows, opts);
    auditArchive(db, rows, opts);
    markParentsDirty(db, rows, opts.who);
    // afterArchive hook: connector idempotency markers (e.g. slack_event_log) must commit atomically with the archive,
    // so it runs INSIDE the SAVEPOINT; throwing rolls back both.
    for (const row of rows) opts.afterArchive?.(db, row.id);
    return archivedAt;
  });
}

/** The only way to remove a `kind='raw'` row: snapshots it into `raw_archive`, flips `kind` to 'archived' so the
 * append-only trigger allows the delete, all in one write scope that nests in an outer transaction. Throws if the row
 * is missing or not raw; returns the archived_at. */
export function archiveRawMemory(db: DatabaseSyncLike, id: string, opts: ArchiveOptions): string {
  return archiveRawMemories(db, [id], opts);
}
