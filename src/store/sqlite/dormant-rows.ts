// The dormant_memories rows: the snapshot sleep keeps of a faded memory, read and written on the caller's handle.
import type { DatabaseSyncLike } from '../../db/index.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { fromWire, toWire, type MemoryWire } from '../../base/memory/memory-wire.js';
import { isObjectLike, isStringValue } from '../../base/session/capture-contract.js';
import type { JsonValue } from '../../base/util/json.js';
import type { SqlFragment } from './rule-sql.js';
import { chunked } from '../../base/util/chunked.js';
import { escapeLike } from '../../base/util/escape.js';
import { placeholders } from '../../base/util/sql.js';
import { parseStoredJson, warnDamagedColumn } from '../../base/util/stored-json.js';
import { cachedStatement } from './statement-cache.js';
import type { DormantMove } from '../local/consolidation.js';
import type { DormantMemory, ListDormantOpts } from '../port/dormant.js';
import type { DormantSnapshot } from '../port/types.js';

// SAFETY: every read cast to this row selects DORMANT_COLUMNS; scripts/check-row-casts.mjs proves it.
interface DormantRow {
  tenant_id: string;
  id: string;
  content: string;
  entry_json: string;
  reason: string;
  strength: number;
  dormant_at: string;
}
const DORMANT_COLUMNS = 'tenant_id, id, content, entry_json, reason, strength, dormant_at';

const DEFAULT_DORMANT_LIMIT = 20;

/** Insert (or refresh) the dormant snapshot for `move.entry`; the caller deletes the `memories` row in the same
 * transaction. */
export function insertDormantRow(db: DatabaseSyncLike, move: DormantMove): void {
  db.prepare(`
    INSERT INTO dormant_memories (tenant_id, id, content, entry_json, reason, strength, dormant_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, id) DO UPDATE SET
      content = excluded.content,
      entry_json = excluded.entry_json,
      reason = excluded.reason,
      strength = excluded.strength,
      dormant_at = excluded.dormant_at
  `).run(
    move.entry.tenantId,
    move.entry.id,
    move.entry.content,
    JSON.stringify(toWire(move.entry)),
    move.reason,
    move.strength,
    move.dormantAt,
  );
}

/** What entry_json may hold: the wire keys, whose tenant is `tenant_id`, or a 1.x snapshot, whose tenant is `tenantId`;
 * a 1.x `summary_dirty` is 0|1. */
type StoredSnapshot = Omit<MemoryWire, 'tenant_id' | 'summary_dirty'> & {
  summary_dirty?: boolean | 0 | 1;
} & ({ tenant_id: string } | { tenantId: string });

function toCurrentEntry(snapshot: StoredSnapshot): MemoryEntry {
  if ('tenant_id' in snapshot) {
    const { summary_dirty, ...rest } = snapshot;
    return fromWire({ ...rest, summary_dirty: summary_dirty === true || summary_dirty === 1 });
  }
  const { tenantId, summary_dirty, ...rest } = snapshot;
  return fromWire({ ...rest, tenant_id: tenantId, summary_dirty: summary_dirty === true || summary_dirty === 1 });
}

/** Parse a stored snapshot back into a MemoryEntry, or null when the row no longer matches it (edited by hand, or
 * truncated). */
function parseSnapshot(row: DormantRow): MemoryEntry | null {
  const site = { table: 'dormant_memories', id: row.id, column: 'entry_json' };
  // A row that will not parse, or parses to another shape or identity, is not restorable.
  const parsed = parseStoredJson(site, row.entry_json);
  if (parsed === undefined) return null;
  const entry = isStoredSnapshot(parsed) ? toCurrentEntry(parsed) : undefined;
  if (entry === undefined || entry.id !== row.id || entry.tenantId !== row.tenant_id || entry.content !== row.content) {
    warnDamagedColumn(site, 'wrong shape');
    return null;
  }
  return entry;
}

/** The part of a parsed entry_json that toCurrentEntry reads without a guard; the row's tenant is compared after. */
function isStoredSnapshot(value: JsonValue): value is JsonValue & StoredSnapshot {
  return (
    isObjectLike(value) &&
    'id' in value &&
    isStringValue(value.id) &&
    'content' in value &&
    isStringValue(value.content)
  );
}

function rowToDormantMemory(row: DormantRow): DormantMemory {
  const entry = parseSnapshot(row);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    content: row.content,
    tags: entry && Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    strength: row.strength,
    reason: row.reason,
    dormantAt: row.dormant_at,
  };
}

// The snapshot's scope as a `scope` column, so recall-scope's SQL fragments read it as they read memories.scope.
const DORMANT_WITH_SCOPE =
  `(SELECT *, CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.scope') END ` +
  `AS scope FROM dormant_memories)`;
export const EVERY_SCOPE: SqlFragment = { sql: '1', params: [] };

/** A tenant's dormant memories whose scope `admit` passes, newest first, optionally filtered by search terms. */
export function listDormantRows(
  db: DatabaseSyncLike,
  tenantId: string,
  opts: ListDormantOpts = {},
  admit: SqlFragment = EVERY_SCOPE,
): DormantMemory[] {
  const terms = (opts.query ?? '')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const limit =
    opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit >= 1
      ? Math.floor(opts.limit)
      : DEFAULT_DORMANT_LIMIT;
  const termClauses = terms.map(() => ` AND content LIKE ? ESCAPE '\\'`).join('');
  const rows = db
    .prepare(
      `SELECT ${DORMANT_COLUMNS}
       FROM ${DORMANT_WITH_SCOPE}
      WHERE tenant_id = ? AND ${admit.sql}${termClauses}
      ORDER BY dormant_at DESC, id ASC
      LIMIT ?`,
    )
    .all(tenantId, ...admit.params, ...terms.map((t) => `%${escapeLike(t)}%`), limit) as DormantRow[];
  return rows.map(rowToDormantMemory);
}

/** A tenant's stored dormant snapshot, or null when it has none with that id (another tenant's id reads as absent). */
export function readDormantSnapshot(db: DatabaseSyncLike, tenantId: string, id: string): DormantSnapshot | null {
  const row = db
    .prepare(
      `SELECT ${DORMANT_COLUMNS}
       FROM dormant_memories WHERE tenant_id = ? AND id = ?`,
    )
    .get(tenantId, id) as DormantRow | undefined;
  return row ? toSnapshot(row) : null;
}

/** Readable snapshots whose entry's source starts with `prefix`; a malformed snapshot is passed over, not an error. */
export function dormantSnapshotsBySourcePrefix(
  db: DatabaseSyncLike,
  tenantId: string,
  prefix: string,
): DormantSnapshot[] {
  const rows = db
    .prepare(
      `SELECT ${DORMANT_COLUMNS}
       FROM dormant_memories
      WHERE tenant_id = ?
        AND CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.source') END LIKE ? ESCAPE '\\'`,
    )
    .all(tenantId, `${escapeLike(prefix)}%`) as DormantRow[];
  return rows.flatMap((row) => toSnapshot(row) ?? []).filter((s) => String(s.entry.source).startsWith(prefix));
}

/** Readable snapshots of a tenant whose entry carries project name `origin`. */
export function dormantSnapshotsFromOrigin(db: DatabaseSyncLike, tenantId: string, origin: string): DormantSnapshot[] {
  const rows = cachedStatement(
    db,
    `SELECT ${DORMANT_COLUMNS}
       FROM dormant_memories
      WHERE tenant_id = ?
        AND CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.origin_project') END = ?`,
  ).all(tenantId, origin) as DormantRow[];
  return rows.flatMap((row) => toSnapshot(row) ?? []).filter((s) => s.entry.originProject === origin);
}

function toSnapshot(row: DormantRow): DormantSnapshot | null {
  const entry = parseSnapshot(row);
  return entry ? { entry, reason: row.reason, strength: row.strength, dormantAt: row.dormant_at } : null;
}

/** Put `entry` in place of a tenant's dormant memory `id`, keeping when and why that one went dormant. */
export function replaceDormantEntry(db: DatabaseSyncLike, tenantId: string, id: string, entry: MemoryEntry): void {
  db.prepare(`UPDATE dormant_memories SET id = ?, content = ?, entry_json = ? WHERE tenant_id = ? AND id = ?`).run(
    entry.id,
    entry.content,
    JSON.stringify(toWire(entry)),
    tenantId,
    id,
  );
}

/** Whether a tenant has a dormant memory with this id whose scope `admit` passes (snapshot readable or not). */
export function hasDormantRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  admit: SqlFragment = EVERY_SCOPE,
): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM ${DORMANT_WITH_SCOPE} WHERE tenant_id = ? AND id = ? AND ${admit.sql}`)
      .get(tenantId, id, ...admit.params) !== undefined
  );
}

/** Delete a tenant's dormant memory. Returns false when there was none. */
export function deleteDormantRow(db: DatabaseSyncLike, tenantId: string, id: string): boolean {
  const result = db.prepare(`DELETE FROM dormant_memories WHERE tenant_id = ? AND id = ?`).run(tenantId, id);
  return Number(result.changes ?? 0) > 0;
}

/**
 * The columns a text match reads from one dormant memory; source and scope are null when its snapshot will not parse.
 */
// SAFETY: every read cast to this row selects DORMANT_TEXT_COLUMNS; scripts/check-row-casts.mjs proves it.
interface DormantText {
  readonly id: string;
  readonly content: string;
  readonly source: string | null;
  readonly scope: string | null;
}

const DORMANT_TEXT_COLUMNS =
  `id, content, CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.source') END AS source, ` +
  `CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.scope') END AS scope`;

/**
 * Up to `limit` of a tenant's dormant memories with ids after `afterId`, by id, with the columns a text match reads.
 */
export function dormantTextsPage(
  db: DatabaseSyncLike,
  tenantId: string,
  page: { readonly limit: number; readonly afterId: string },
): DormantText[] {
  return cachedStatement(
    db,
    `SELECT ${DORMANT_TEXT_COLUMNS} FROM dormant_memories WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?`,
  ).all(tenantId, page.afterId, page.limit) as DormantText[];
}

/** The text columns of a tenant's dormant memories with these ids, one query per chunk. */
export function dormantTextsByIds(
  db: DatabaseSyncLike,
  tenantId: string,
  ids: readonly string[],
): Map<string, DormantText> {
  const byId = new Map<string, DormantText>();
  for (const chunk of chunked([...new Set(ids)])) {
    const rows = cachedStatement(
      db,
      `SELECT ${DORMANT_TEXT_COLUMNS} FROM dormant_memories ` +
        `WHERE tenant_id = ? AND id IN (${placeholders(chunk.length)})`,
    ).all(tenantId, ...chunk) as DormantText[];
    for (const row of rows) byId.set(row.id, row);
  }
  return byId;
}

/** A tenant's dormant snapshots with these ids that still read back, one query per chunk. */
export function dormantSnapshotsByIds(
  db: DatabaseSyncLike,
  tenantId: string,
  ids: readonly string[],
): Map<string, DormantSnapshot> {
  const byId = new Map<string, DormantSnapshot>();
  for (const chunk of chunked([...new Set(ids)])) {
    const rows = cachedStatement(
      db,
      `SELECT ${DORMANT_COLUMNS}
         FROM dormant_memories WHERE tenant_id = ? AND id IN (${placeholders(chunk.length)})`,
    ).all(tenantId, ...chunk) as DormantRow[];
    for (const row of rows) {
      const snapshot = toSnapshot(row);
      if (snapshot) byId.set(row.id, snapshot);
    }
  }
  return byId;
}
