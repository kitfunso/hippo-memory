import { DEFAULT_TENANT_ID } from '../../../base/util/tenant.js';
import { memoryNotFoundText, NotFoundError } from '../../../base/errors/api-errors.js';
import { rawRemovalRefusal } from '../../../base/errors/raw-append-only.js';
import type { DatabaseSyncLike } from '../../../db/index.js';
import { isFtsAvailable, isSqliteBusy, withWriteScope } from '../../../db/index.js';
import { appendAuditEvents } from '../audit/audit.js';
import { reportAuditWriteFailure } from '../../../base/records/audit-report.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { CLI_ACTOR } from '../../../base/scope/actor.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { handleStamp } from '../runtime/handle-clock.js';
import { errorFields, log } from '../../../base/util/log.js';

export interface ArchiveOptions {
  reason: string;
  who: string;
  afterArchive?: (db: DatabaseSyncLike, archivedMemoryId: string) => void;
}

interface ArchivedMemoryRow {
  id: string;
  kind: string;
  tenant_id: string | null;
  dag_parent_id: string | null;
}

/** Stamps the archived copy of `memoryId` as having its markdown mirror cleaned at `at`; a busy store
 * leaves it unstamped for the reaper, since the change it follows has already committed. */
export function markMirrorCleaned(db: DatabaseSyncLike, memoryId: string, at: string): void {
  try {
    cachedStatement(db, `UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
      at,
      memoryId,
    );
  } catch (err) {
    if (!isSqliteBusy(err)) throw err;
    log.warnThenDebug(
      'archive-mirror-stamp-busy',
      `removed raw ${memoryId}; the store was busy, so the mirror reaper will re-check it on the next open`,
      errorFields(err),
    );
  }
}

const IDS = 'SELECT value FROM json_each(?)';

function readRawRows(db: DatabaseSyncLike, ids: readonly string[]): ArchivedMemoryRow[] {
  // SAFETY: the four selected columns are the interface's keys, each a memories column.
  const rows = cachedStatement(
    db,
    `SELECT id, kind, tenant_id, dag_parent_id FROM memories WHERE id IN (${IDS})`,
  ).all(JSON.stringify(ids)) as ArchivedMemoryRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new NotFoundError(memoryNotFoundText(id));
    const refusal = rawRemovalRefusal(row, true);
    if (refusal !== null) throw refusal;
    return row;
  });
}

function moveRowsToArchive(
  db: DatabaseSyncLike,
  rows: readonly ArchivedMemoryRow[],
  opts: ArchiveOptions,
): string {
  const archivedAt = handleStamp(db);
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
  cachedStatement(db, `UPDATE memories SET kind = 'archived' WHERE id IN (${IDS})`).run(ids);
  cachedStatement(db, `DELETE FROM memories WHERE id IN (${IDS})`).run(ids);
  if (isFtsAvailable(db)) {
    cachedStatement(db, `DELETE FROM memories_fts WHERE id IN (${IDS})`).run(ids);
  }
  return archivedAt;
}

function auditArchive(
  db: DatabaseSyncLike,
  rows: readonly ArchivedMemoryRow[],
  opts: ArchiveOptions,
): void {
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
    for (const row of rows) reportAuditWriteFailure('archive_raw', error, row.id);
  }
}

function markParentsDirty(
  db: DatabaseSyncLike,
  rows: readonly ArchivedMemoryRow[],
  who: string,
): void {
  const parents = new Map<string, string>();
  for (const row of rows) {
    if (row.dag_parent_id) {
      parents.set(String(row.dag_parent_id), String(row.tenant_id ?? DEFAULT_TENANT_ID));
    }
  }
  for (const [parent, tenant] of parents) {
    markSummaryDirtyInTx(db, { summaryId: parent, tenantId: tenant, actor: who || CLI_ACTOR });
  }
}

/** archiveRawMemory for every row in `ids` in one write scope, in the same few statements for
 * one row or many; throws, archiving none, if any is missing or not raw. Returns the
 * archived_at. */
export function archiveRawMemories(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: ArchiveOptions,
): string {
  const rows = readRawRows(db, [...new Set(ids)]);
  return withWriteScope(db, 'archive_raw', () => {
    const archivedAt = moveRowsToArchive(db, rows, opts);
    auditArchive(db, rows, opts);
    markParentsDirty(db, rows, opts.who);
    for (const row of rows) opts.afterArchive?.(db, row.id);
    return archivedAt;
  });
}

/** The only way to remove a `kind='raw'` row: snapshots it into `raw_archive`, flips `kind` to
 * 'archived' so the append-only trigger allows the delete, all in one write scope that nests in
 * an outer transaction. Throws if the row is missing or not raw; returns the archived_at. */
export function archiveRawMemory(db: DatabaseSyncLike, id: string, opts: ArchiveOptions): string {
  return archiveRawMemories(db, [id], opts);
}
