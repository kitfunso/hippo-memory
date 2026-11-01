import { cachedStatement } from '../../../db/statement-cache.js';
import { DEFAULT_TENANT_ID } from '../../../base/util/tenant.js';
import type { MemoryEntry } from '../../../base/memory/entry.js';
import { isoInstant } from '../../../base/memory/created-stamp.js';
import {
  changedRows,
  type DatabaseSyncLike,
  ftsRowCounts,
  isFtsAvailable,
  repairFtsDrift,
  setFtsInSync,
} from '../../../db/index.js';
import { fallbackOrigin, type Host } from '../../../host/host.js';
import { originFromSource } from '../../../host/project-identity.js';
import { CrossTenantIdError } from '../../../base/errors/api-errors.js';
import { checkRejectionGuard } from '../review/rejection.js';
import { errorMessage, log, errorFields } from '../../../base/util/log.js';
import type { StoreFiles } from '../runtime/open.js';
import { chunked } from '../../../base/util/chunked.js';
import { MEMORY_ROW_COLUMNS } from '../runtime/rows.js';
import { placeholders, rowsPerStatement, valuesRows } from '../../../db/sql.js';
import { duplicateHash } from '../../../base/util/same-text.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import type { RenameSourceOptions } from '../../../base/records/agent-import.js';

/** A 2.x JS caller's `tenant_id` would otherwise fall through to the default tenant without a
 * sound. */
function rejectLegacyTenantKey(entry: MemoryEntry): void {
  if (Object.hasOwn(entry, 'tenant_id') && entry.tenantId === undefined) {
    throw new TypeError('tenant_id was renamed to tenantId in 3.0');
  }
}

export function upsertEntryRow(db: DatabaseSyncLike, entry: MemoryEntry): void {
  rejectLegacyTenantKey(entry);
  const tenantId = entry.tenantId ?? DEFAULT_TENANT_ID;
  checkRejectionGuard(db, { tenantId, entryId: entry.id, content: entry.content });
  syncFtsRow(db, entry, upsertMemoryRow(db, entry));
}

/** The row alone, with no rejection guard or full-text row, for `upsertEntryRow` and for
 * `batchWriteAndDelete`, which probes tombstones and indexes per batch. Throws
 * CrossTenantIdError before writing when another tenant holds the id (the existence probe reads
 * the holder, so the hot path pays no extra read). Returns whether the row is new. */
export function upsertMemoryRow(db: DatabaseSyncLike, entry: MemoryEntry): boolean {
  const holder = db.prepare(`SELECT tenant_id FROM memories WHERE id = ?`).get(entry.id) as
    | { tenant_id: string }
    | undefined;
  if (holder !== undefined && holder.tenant_id !== (entry.tenantId ?? DEFAULT_TENANT_ID)) {
    throw new CrossTenantIdError(entry.id);
  }
  db.prepare(UPSERT_MEMORY_SQL).run(...memoryRowValues(entry));
  return holder === undefined;
}

// The duplicate read's key goes with every row write; no read selects it, so it stays out of
// MEMORY_ROW_COLUMNS.
const WRITTEN_COLUMNS = [...MEMORY_ROW_COLUMNS, 'duplicate_hash'] as const;
const UPDATED_COLUMNS = WRITTEN_COLUMNS.slice(1);

const UPSERT_MEMORY_SQL =
  `INSERT INTO memories(${WRITTEN_COLUMNS.join(', ')}, updated_at) ` +
  `VALUES (${placeholders(WRITTEN_COLUMNS.length)}, datetime('now')) ` +
  `ON CONFLICT(id) DO UPDATE SET ${UPDATED_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}, ` +
  `updated_at = datetime('now')`;

/** Rewrites rows already in `memories` as the upsert's update arm does, one UPDATE per chunk of
 * rows. The caller owns the transaction, the rejection guard and the full-text rows. */
export function updateMemoryRows(db: DatabaseSyncLike, entries: readonly MemoryEntry[]): void {
  const set = UPDATED_COLUMNS.map((c) => `${c} = v.${c}`).join(', ');
  for (const chunk of chunked(entries, rowsPerStatement(WRITTEN_COLUMNS.length))) {
    cachedStatement(
      db,
      `WITH v(${WRITTEN_COLUMNS.join(', ')}) AS (VALUES ${valuesRows(chunk.length, WRITTEN_COLUMNS.length)}) ` +
        `UPDATE memories SET ${set}, updated_at = datetime('now') FROM v WHERE memories.id = v.id`,
    ).run(...chunk.flatMap(memoryRowValues));
  }
}

/** Bind values for WRITTEN_COLUMNS, in its order. */
function memoryRowValues(entry: MemoryEntry): Array<string | number | null> {
  // Markdown rebuilds, imports and add-ons pass stamps as written; only toISOString text sorts by
  // time in SQL.
  const created = isoInstant(entry.created) ?? entry.created;
  return [
    entry.id,
    created,
    entry.lastRetrieved,
    entry.retrievalCount,
    entry.strength,
    entry.halfLifeDays,
    entry.layer,
    JSON.stringify(entry.tags ?? []),
    entry.emotionalValence,
    entry.schemaFit,
    entry.source,
    entry.outcomeScore,
    entry.outcomePositive ?? 0,
    entry.outcomeNegative ?? 0,
    JSON.stringify(entry.conflictsWith ?? []),
    entry.pinned ? 1 : 0,
    entry.confidence,
    entry.content,
    JSON.stringify(entry.parents ?? []),
    entry.starred ? 1 : 0,
    entry.traceOutcome ?? null,
    entry.sourceSessionId ?? null,
    entry.validFrom ?? created,
    entry.supersededBy ?? null,
    entry.extractedFrom ?? null,
    entry.dagLevel ?? 0,
    entry.dagParentId ?? null,
    entry.kind ?? 'distilled',
    entry.scope ?? null,
    entry.owner ?? null,
    entry.artifactRef ?? null,
    entry.tenantId ?? DEFAULT_TENANT_ID,
    entry.originProject ?? null,
    entry.descendantCount ?? 0,
    entry.earliestAt ?? null,
    entry.latestAt ?? null,
    entry.dagLevel3BuiltAt ?? null,
    duplicateHash(entry.content),
  ];
}

// A failed index write makes the in-sync flag untrue, so reads skip the index until sleep
// recounts it.
function markFtsDrifted(db: DatabaseSyncLike): void {
  try {
    setFtsInSync(db, false);
  } catch (err) {
    log.warnThenSample(
      'fts-sync',
      `could not clear the FTS in-sync flag: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

export function syncFtsRow(
  db: DatabaseSyncLike,
  entry: Pick<MemoryEntry, 'id' | 'content' | 'tags'>,
  isNewRow = false,
): void {
  if (!isFtsAvailable(db)) return;
  try {
    if (!isNewRow) db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(entry.id);
    db.prepare(`INSERT INTO memories_fts(id, content, tags) VALUES (?, ?, ?)`).run(
      entry.id,
      entry.content,
      entry.tags.join(' '),
    );
  } catch (err) {
    markFtsDrifted(db);
    // The memories table stays authoritative; a stale FTS row only costs recall quality, so the
    // write goes on.
    log.warnThenSample(
      'fts-sync',
      `FTS index update failed for ${entry.id}; keyword recall may miss it: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

export function ftsRowExists(db: DatabaseSyncLike, id: string): boolean {
  return db.prepare('SELECT id FROM memories_fts WHERE id = ?').get(id) !== undefined;
}

export function deleteFtsRow(db: DatabaseSyncLike, id: string): void {
  if (!isFtsAvailable(db)) return;
  try {
    db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(id);
  } catch (err) {
    markFtsDrifted(db);
    log.warnThenSample(
      'fts-delete',
      `FTS index delete failed for ${id}; recall may return a stale hit: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

/** One set delete for `staleIds`, because `id` is UNINDEXED and each delete by id scans the
 * whole index; then one insert per row. */
export function replaceFtsRows(
  db: DatabaseSyncLike,
  rows: readonly MemoryEntry[],
  staleIds: readonly string[],
): void {
  if (!isFtsAvailable(db)) return;
  let kept: ReadonlySet<string> = new Set();
  if (staleIds.length > 0) {
    try {
      db.prepare(`DELETE FROM memories_fts WHERE id IN (SELECT value FROM json_each(?))`).run(
        JSON.stringify(staleIds),
      );
    } catch (err) {
      // Their old rows are still indexed, so inserting them again would index an id twice; only new
      // ids go in.
      kept = new Set(staleIds);
      markFtsDrifted(db);
      log.warnThenSample(
        'fts-delete',
        `FTS index delete failed for ${staleIds.length} row(s); recall may return a stale hit: ${errorMessage(err)}`,
        errorFields(err),
      );
    }
  }
  const toInsert = rows.filter((row) => !kept.has(row.id));
  if (toInsert.length === 0) return;
  const insert = db.prepare(`INSERT INTO memories_fts(id, content, tags) VALUES (?, ?, ?)`);
  for (const row of toInsert) {
    try {
      insert.run(row.id, row.content, row.tags.join(' '));
    } catch (err) {
      markFtsDrifted(db);
      log.warnThenSample(
        'fts-sync',
        `FTS index update failed for ${row.id}; keyword recall may miss it: ${errorMessage(err)}`,
        errorFields(err),
      );
    }
  }
}

/** Row counts of a full-text index that has drifted from `memories`, re-synced after the count
 * when `repair`; null when the two agree or there is no index. */
export function ftsDrift(
  db: DatabaseSyncLike,
  repair: boolean,
): { memories: number; fts: number } | null {
  if (!isFtsAvailable(db)) return null;
  const counts = ftsRowCounts(db);
  if (counts === null) return null;
  if (counts.memories === counts.fts) {
    setFtsInSync(db, true);
    return null;
  }
  if (repair) repairFtsDrift(db);
  return counts;
}

/** Stamp origin_project from the store's own location (parent of `<project>/.hippo`; the home
 * store is '' = user-global) when never stamped; returns a copy. NULL is PRESERVED: it means no
 * known project and ambient context denies it, so a writeback must not launder it. */
export function stampOriginProject(
  { host, hippoRoot }: StoreFiles,
  entry: MemoryEntry,
): MemoryEntry {
  if (entry.originProject !== undefined) return entry;
  return { ...entry, originProject: fallbackOrigin(host, hippoRoot) };
}

/** Import-time variant for a mirror with no origin field (an explicit null stays null), for rows
 * predating the origin column. Like the v39 backfill, the provenance source (`shared:<project>:`
 * / `promoted:<localRoot>`) wins over the destination store's location. */
export function stampOriginProjectForImport(
  host: Host,
  hippoRoot: string,
  entry: MemoryEntry,
): MemoryEntry {
  if (entry.originProject !== undefined) return entry;
  const fromSource = originFromSource(entry.source);
  return {
    ...entry,
    originProject: fromSource ?? fallbackOrigin(host, hippoRoot),
  };
}

/** Rewrites a live row's tags and its full-text row on the caller's transaction, with no audit
 * row. */
export function setEntryTagsInTx(db: DatabaseSyncLike, entry: MemoryEntry): void {
  cachedStatement(
    db,
    `UPDATE memories SET tags_json = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`,
  ).run(JSON.stringify(entry.tags), entry.id, entry.tenantId);
  syncFtsRow(db, entry);
}

/** Removes a row from `memories` and full-text search on the caller's transaction, as sleep's
 * dormant move does, and marks its summary parent dirty. */
export function deleteEntryRowInTx(db: DatabaseSyncLike, entry: MemoryEntry, actor: string): void {
  cachedStatement(db, 'DELETE FROM memories WHERE id = ? AND tenant_id = ?').run(
    entry.id,
    entry.tenantId,
  );
  deleteFtsRow(db, entry.id);
  if (entry.dagParentId) {
    markSummaryDirtyInTx(db, { summaryId: entry.dagParentId, tenantId: entry.tenantId, actor });
  }
}

// The last value given for an id wins, as a row-by-row write left it: UPDATE FROM applies any one
// of an id's matches.
const lastPerId = (pairs: ReadonlyArray<readonly [string, number | string]>): string =>
  JSON.stringify([...new Map(pairs)]);

const HALF_LIFE_UPDATE_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS hl FROM json_each(?)) ` +
  `UPDATE memories SET half_life_days = v.hl FROM v WHERE memories.id = v.id`;

/** One half-life per memory id, in one statement on the caller's transaction. */
export function setHalfLives(
  db: DatabaseSyncLike,
  rows: readonly { id: string; halfLifeDays: number }[],
): void {
  if (rows.length === 0) return;
  cachedStatement(db, HALF_LIFE_UPDATE_SQL).run(lastPerId(rows.map((r) => [r.id, r.halfLifeDays])));
}

/** A tenant's project `from` and the project `into` that takes its rows. */
export interface OriginMoveOptions {
  readonly tenantId: string;
  readonly from: string;
  readonly into: string;
}

/** Moves every row of `from` in a tenant to project `into`. */
export function restampOriginProject(
  db: DatabaseSyncLike,
  { tenantId, from, into }: OriginMoveOptions,
): void {
  cachedStatement(
    db,
    `UPDATE memories SET origin_project = ?, updated_at = datetime('now') WHERE tenant_id = ? AND origin_project = ?`,
  ).run(into, tenantId, from);
}

const ORIGIN_STAMP_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS origin FROM json_each(?)) ` +
  `UPDATE memories SET origin_project = v.origin, updated_at = datetime('now') FROM v ` +
  `WHERE memories.id = v.id AND memories.tenant_id = ?`;

/** Stamps each id with its project, in one statement. */
export function stampOriginProjects(
  db: DatabaseSyncLike,
  tenantId: string,
  rows: readonly { id: string; origin: string }[],
): void {
  if (rows.length === 0) return;
  cachedStatement(db, ORIGIN_STAMP_SQL).run(lastPerId(rows.map((r) => [r.id, r.origin])), tenantId);
}

/** A tenant's row `id` and the source names it moves `from` and `to`. */
interface RenameEntrySourceOptions {
  readonly tenantId: string;
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** Renames a live row's source from `from` to `to`; the count is 0 when another writer moved or
 * superseded it first. */
export function renameEntrySource(
  db: DatabaseSyncLike,
  { tenantId, id, from, to }: RenameEntrySourceOptions,
): number {
  const moved = cachedStatement(
    db,
    `UPDATE memories SET source = ? WHERE id = ? AND tenant_id = ? AND source = ? AND superseded_by IS NULL`,
  ).run(to, id, tenantId, from);
  return changedRows(moved);
}

/** Renames a row's source and, when `origin` is not null, its project; the count is 0 when the
 * row is gone or moved. */
export function renameEntrySourceAndOrigin(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  options: RenameSourceOptions,
): number {
  const { from, to, origin } = options;
  const done = cachedStatement(
    db,
    `UPDATE memories SET source = ?, origin_project = COALESCE(?, origin_project) WHERE id = ? AND tenant_id = ? ` +
      `AND source = ?`,
  ).run(to, origin, id, tenantId, from);
  return changedRows(done);
}

/** A tenant's row `id` and the row `newId` that supersedes it. */
interface SupersedeEntryOptions {
  readonly tenantId: string;
  readonly id: string;
  readonly newId: string;
}

/** Marks `id` superseded by `newId`; false when another writer superseded it first. */
export function supersedeEntry(
  db: DatabaseSyncLike,
  { tenantId, id, newId }: SupersedeEntryOptions,
): boolean {
  const result = cachedStatement(
    db,
    `UPDATE memories SET superseded_by = ? WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL`,
  ).run(newId, id, tenantId);
  return changedRows(result) > 0;
}
