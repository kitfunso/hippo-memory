import { DEFAULT_TENANT_ID } from '../../util/tenant.js';
import type { MemoryEntry } from '../../core/memory.js';
import {
  type DatabaseSyncLike,
  ftsRowCounts,
  openHippoDb,
  isFtsAvailable,
  repairFtsDrift,
  setFtsInSync,
} from '../../db/index.js';
import { fallbackOrigin, originFromSource } from '../../core/project-identity.js';
import { checkRejectionGuard } from './rejection.js';
import { errorMessage, log, errorFields } from '../../util/log.js';
import type { StoreFiles } from './open.js';
import { chunked } from '../../util/chunked.js';
import { placeholders, rowsPerStatement, valuesRows } from '../../util/sql.js';

/** A 2.x JS caller's `tenant_id` would otherwise fall through to the default tenant without a sound. */
function rejectLegacyTenantKey(entry: MemoryEntry): void {
  if (Object.hasOwn(entry, 'tenant_id') && entry.tenantId === undefined) {
    throw new TypeError('tenant_id was renamed to tenantId in 3.0');
  }
}

export function upsertEntryRow(db: ReturnType<typeof openHippoDb>, entry: MemoryEntry): void {
  rejectLegacyTenantKey(entry);
  checkRejectionGuard(db, entry.tenantId ?? DEFAULT_TENANT_ID, entry.id, entry.content);
  syncFtsRow(db, entry, upsertMemoryRow(db, entry));
}

/** The row alone, with no rejection guard or full-text row, for `upsertEntryRow` and for `batchWriteAndDelete`, which
 * probes tombstones and indexes per batch. Returns whether the row is new. */
export function upsertMemoryRow(db: ReturnType<typeof openHippoDb>, entry: MemoryEntry): boolean {
  const isNewRow = db.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(entry.id) === undefined;
  db.prepare(UPSERT_MEMORY_SQL).run(...memoryRowValues(entry));
  return isNewRow;
}

/** The columns a row write sets, in memoryRowValues' order; the upsert and the batch update share it. */
const MEMORY_ROW_COLUMNS = [
  'id',
  'created',
  'last_retrieved',
  'retrieval_count',
  'strength',
  'half_life_days',
  'layer',
  'tags_json',
  'emotional_valence',
  'schema_fit',
  'source',
  'outcome_score',
  'outcome_positive',
  'outcome_negative',
  'conflicts_with_json',
  'pinned',
  'confidence',
  'content',
  'parents_json',
  'starred',
  'trace_outcome',
  'source_session_id',
  'valid_from',
  'superseded_by',
  'extracted_from',
  'dag_level',
  'dag_parent_id',
  'kind',
  'scope',
  'owner',
  'artifact_ref',
  'tenant_id',
  'origin_project',
  'descendant_count',
  'earliest_at',
  'latest_at',
  'dag_level_3_built_at',
] as const;

const UPDATED_COLUMNS = MEMORY_ROW_COLUMNS.slice(1);

const UPSERT_MEMORY_SQL =
  `INSERT INTO memories(${MEMORY_ROW_COLUMNS.join(', ')}, updated_at) ` +
  `VALUES (${placeholders(MEMORY_ROW_COLUMNS.length)}, datetime('now')) ` +
  `ON CONFLICT(id) DO UPDATE SET ${UPDATED_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}, ` +
  `updated_at = datetime('now')`;

/** Rewrites rows already in `memories` as the upsert's update arm does, one UPDATE per chunk of rows. The caller owns
 * the transaction, the rejection guard and the full-text rows. */
export function updateMemoryRows(db: DatabaseSyncLike, entries: readonly MemoryEntry[]): void {
  const set = UPDATED_COLUMNS.map((c) => `${c} = v.${c}`).join(', ');
  for (const chunk of chunked(entries, rowsPerStatement(MEMORY_ROW_COLUMNS.length))) {
    db.prepare(
      `WITH v(${MEMORY_ROW_COLUMNS.join(', ')}) AS (VALUES ${valuesRows(chunk.length, MEMORY_ROW_COLUMNS.length)}) ` +
        `UPDATE memories SET ${set}, updated_at = datetime('now') FROM v WHERE memories.id = v.id`,
    ).run(...chunk.flatMap(memoryRowValues));
  }
}

/** Bind values for MEMORY_ROW_COLUMNS, in its order. */
function memoryRowValues(entry: MemoryEntry): Array<string | number | null> {
  return [
    entry.id,
    entry.created,
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
    entry.validFrom ?? entry.created,
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
  ];
}

// A failed index write makes the in-sync flag untrue, so reads skip the index until sleep recounts it.
function markFtsDrifted(db: DatabaseSyncLike): void {
  try {
    setFtsInSync(db, false);
  } catch (err) {
    log.warnThenSample('fts-sync', `could not clear the FTS in-sync flag: ${errorMessage(err)}`, errorFields(err));
  }
}

export function syncFtsRow(db: ReturnType<typeof openHippoDb>, entry: MemoryEntry, isNewRow = false): void {
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
    // The memories table stays authoritative; a stale FTS row only costs recall quality, so the write goes on.
    log.warnThenSample(
      'fts-sync',
      `FTS index update failed for ${entry.id}; keyword recall may miss it: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

export function ftsRowExists(db: ReturnType<typeof openHippoDb>, id: string): boolean {
  return db.prepare('SELECT id FROM memories_fts WHERE id = ?').get(id) !== undefined;
}

export function deleteFtsRow(db: ReturnType<typeof openHippoDb>, id: string): void {
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

/** One set delete for `staleIds`, because `id` is UNINDEXED and each delete by id scans the whole index; then one
 * insert per row. */
export function replaceFtsRows(
  db: ReturnType<typeof openHippoDb>,
  rows: readonly MemoryEntry[],
  staleIds: readonly string[],
): void {
  if (!isFtsAvailable(db)) return;
  let kept: ReadonlySet<string> = new Set();
  if (staleIds.length > 0) {
    try {
      db.prepare(`DELETE FROM memories_fts WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(staleIds));
    } catch (err) {
      // Their old rows are still indexed, so inserting them again would index an id twice; only new ids go in.
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

/** Row counts of a full-text index that has drifted from `memories`, re-synced after the count when `repair`; null when
 * the two agree or there is no index. */
export function ftsDriftAt(db: DatabaseSyncLike, repair: boolean): { memories: number; fts: number } | null {
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

/** Stamp origin_project from the store's own location (parent of `<project>/.hippo`; the home store is '' =
 * user-global) when never stamped; returns a copy. NULL is PRESERVED: it means no known project and ambient context
 * denies it, so a writeback must not launder it. */
export function stampOriginProject(hippoRoot: string, entry: MemoryEntry): MemoryEntry {
  if (entry.originProject !== undefined) return entry;
  return { ...entry, originProject: fallbackOrigin(hippoRoot) };
}

export function stampOriginProjectIn(files: StoreFiles, entry: MemoryEntry): MemoryEntry {
  return stampOriginProject(files.hippoRoot, entry);
}

/** Import-time variant for a mirror with no origin field (an explicit null stays null), for rows predating the origin
 * column. Like the v39 backfill, the provenance source (`shared:<project>:` / `promoted:<localRoot>`) wins over the
 * destination store's location. */
export function stampOriginProjectForImport(hippoRoot: string, entry: MemoryEntry): MemoryEntry {
  if (entry.originProject !== undefined) return entry;
  const fromSource = originFromSource(entry.source);
  return {
    ...entry,
    originProject: fromSource ?? fallbackOrigin(hippoRoot),
  };
}
