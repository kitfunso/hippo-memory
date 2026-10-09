/**
 * Dormant memories: what sleep does with a faded memory instead of deleting
 * it (config `dormant.enabled`, on by default; `retentionDays` bounds how
 * long one is kept).
 *
 * A dormant memory keeps its full content in `dormant_memories` (schema v44)
 * but is no longer a `memories` row, so recall, context, every sleep pass and
 * every other reader of `memories` stop seeing it exactly as if it had been
 * deleted. `hippo dormant` lists and searches them, `hippo dormant restore`
 * brings one back, `hippo dormant forget` deletes one for good.
 *
 * Not to be confused with the raw archive (`raw_archive`, `archiveRawMemory`,
 * `hippo forget --archive`): that path removes a raw receipt's content and
 * keeps only its metadata. A dormant memory keeps its content.
 *
 * DB-only helpers: the caller owns the handle and any transaction. The
 * tenant-scoped entry points are api.listDormant / restoreDormant /
 * forgetDormant.
 */
import type { DatabaseSyncLike } from '../db.js';
import type { MemoryEntry } from '../memory.js';
import type { SqlFragment } from '../recall-scope.js';
import { rejectionDigest } from './rejection.js';
import { escapeLike } from '../escape.js';
import { warnDamagedColumn } from '../util/stored-json.js';

/** Why a memory went dormant: sleep's decay pass, an imported agent memory whose note was deleted, `hippo projects repair` splitting a two-project merge, or `hippo audit repair` setting aside an automatic memory with a certain defect. */
export type DormantReason = 'decay' | 'source-deleted' | 'project-repair' | 'quality-repair';

/** One memory that sleep is moving out of active memory into the dormant store. */
export interface DormantMove {
  /** The memory as it stood when it faded; restored verbatim apart from its recall clock. */
  entry: MemoryEntry;
  /** Live strength at the moment it went dormant (below the decay threshold). */
  strength: number;
  reason: DormantReason;
  /** ISO time of the sleep that made it dormant. */
  dormantAt: string;
}

/** A dormant memory as listed to a user. */
export interface DormantMemory {
  id: string;
  tenantId: string;
  content: string;
  tags: string[];
  /** Live strength when it went dormant. */
  strength: number;
  /** Why it went dormant: one of the {@link DormantReason} values. */
  reason: string;
  /** ISO time it went dormant. */
  dormantAt: string;
}

/** Options for {@link listDormantRows}. */
export interface ListDormantOpts {
  /** Whitespace-separated terms; a row must contain every term (case-insensitive substring). */
  query?: string;
  /** Maximum rows returned, newest first. Default 20. */
  limit?: number;
}

interface DormantRow {
  tenant_id: string;
  id: string;
  content: string;
  entry_json: string;
  reason: string;
  strength: number;
  dormant_at: string;
}

const DEFAULT_LIST_LIMIT = 20;

/**
 * Insert (or refresh) the dormant snapshot for `move.entry`. Does not touch
 * the `memories` row: the caller deletes it in the same transaction, so the
 * memory is never in both places or in neither.
 */
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
    JSON.stringify(move.entry),
    move.reason,
    move.strength,
    move.dormantAt,
  );
}

/**
 * Parse a stored snapshot back into a MemoryEntry, or null when the row no
 * longer matches the snapshot it carries (edited by hand, or truncated).
 */
function parseSnapshot(row: DormantRow): MemoryEntry | null {
  try {
    // SAFETY: entry_json is only written by insertDormantRow from a MemoryEntry;
    // the id / tenant / content checks below reject a row edited out of shape.
    const entry = JSON.parse(row.entry_json) as MemoryEntry;
    if (entry.id !== row.id || entry.tenantId !== row.tenant_id || entry.content !== row.content) {
      return null;
    }
    return entry;
  } catch {
    // A row that will not parse is out of shape, so it is not restorable.
    warnDamagedColumn({ table: 'dormant_memories', id: row.id, column: 'entry_json' }, 'not valid JSON');
    return null;
  }
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
const DORMANT_WITH_SCOPE = `(SELECT *, CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.scope') END AS scope FROM dormant_memories)`;
const EVERY_SCOPE: SqlFragment = { sql: '1', params: [] };

/** A tenant's dormant memories whose scope `admit` passes, newest first, optionally filtered by search terms. */
export function listDormantRows(db: DatabaseSyncLike, tenantId: string, opts: ListDormantOpts = {}, admit: SqlFragment = EVERY_SCOPE): DormantMemory[] {
  const terms = (opts.query ?? '').trim().split(/\s+/).filter((t) => t.length > 0);
  const limit = opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit >= 1
    ? Math.floor(opts.limit)
    : DEFAULT_LIST_LIMIT;
  const termClauses = terms.map(() => ` AND content LIKE ? ESCAPE '\\'`).join('');
  // SAFETY: rows' shape matches the seven columns named in the SELECT.
  const rows = db.prepare(
    `SELECT tenant_id, id, content, entry_json, reason, strength, dormant_at
       FROM ${DORMANT_WITH_SCOPE}
      WHERE tenant_id = ? AND ${admit.sql}${termClauses}
      ORDER BY dormant_at DESC, id ASC
      LIMIT ?`,
  ).all(tenantId, ...admit.params, ...terms.map((t) => `%${escapeLike(t)}%`), limit) as DormantRow[];
  return rows.map(rowToDormantMemory);
}

/** A dormant memory's stored snapshot plus when and why it went dormant. */
export interface DormantSnapshot {
  entry: MemoryEntry;
  reason: string;
  strength: number;
  dormantAt: string;
}

/**
 * The stored snapshot for a tenant's dormant memory, or null when the tenant
 * has no dormant memory with that id (another tenant's id reads as absent).
 */
export function readDormantSnapshot(db: DatabaseSyncLike, tenantId: string, id: string): DormantSnapshot | null {
  // SAFETY: row's shape matches the seven columns named in the SELECT.
  const row = db.prepare(
    `SELECT tenant_id, id, content, entry_json, reason, strength, dormant_at
       FROM dormant_memories WHERE tenant_id = ? AND id = ?`,
  ).get(tenantId, id) as DormantRow | undefined;
  return row ? toSnapshot(row) : null;
}

/** Every dormant memory of a tenant whose snapshot still reads back. */
export function listDormantSnapshots(db: DatabaseSyncLike, tenantId: string): DormantSnapshot[] {
  // SAFETY: rows' shape matches the seven columns named in the SELECT.
  const rows = db.prepare(
    `SELECT tenant_id, id, content, entry_json, reason, strength, dormant_at
       FROM dormant_memories WHERE tenant_id = ?`,
  ).all(tenantId) as DormantRow[];
  return rows.flatMap((row) => toSnapshot(row) ?? []);
}

/** Readable snapshots whose entry's source starts with `prefix`; a malformed snapshot is passed over, not an error. */
export function dormantSnapshotsBySourcePrefix(db: DatabaseSyncLike, tenantId: string, prefix: string): DormantSnapshot[] {
  // SAFETY: rows' shape matches the seven columns named in the SELECT.
  const rows = db.prepare(
    `SELECT tenant_id, id, content, entry_json, reason, strength, dormant_at
       FROM dormant_memories
      WHERE tenant_id = ?
        AND CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.source') END LIKE ? ESCAPE '\\'`,
  ).all(tenantId, `${escapeLike(prefix)}%`) as DormantRow[];
  return rows.flatMap((row) => toSnapshot(row) ?? []).filter((s) => String(s.entry.source).startsWith(prefix));
}

function toSnapshot(row: DormantRow): DormantSnapshot | null {
  const entry = parseSnapshot(row);
  return entry ? { entry, reason: row.reason, strength: row.strength, dormantAt: row.dormant_at } : null;
}

/** Put `entry` in place of a tenant's dormant memory `id`, keeping when and why that one went dormant. */
export function replaceDormantEntry(db: DatabaseSyncLike, tenantId: string, id: string, entry: MemoryEntry): void {
  db.prepare(`UPDATE dormant_memories SET id = ?, content = ?, entry_json = ? WHERE tenant_id = ? AND id = ?`)
    .run(entry.id, entry.content, JSON.stringify(entry), tenantId, id);
}

/** Whether a tenant has a dormant memory with this id whose scope `admit` passes (snapshot readable or not). */
export function hasDormantRow(db: DatabaseSyncLike, tenantId: string, id: string, admit: SqlFragment = EVERY_SCOPE): boolean {
  return db.prepare(`SELECT 1 FROM ${DORMANT_WITH_SCOPE} WHERE tenant_id = ? AND id = ? AND ${admit.sql}`).get(tenantId, id, ...admit.params) !== undefined;
}

/** Delete a tenant's dormant memory. Returns false when there was none. */
export function deleteDormantRow(db: DatabaseSyncLike, tenantId: string, id: string): boolean {
  const result = db.prepare(`DELETE FROM dormant_memories WHERE tenant_id = ? AND id = ?`).run(tenantId, id);
  return Number(result.changes ?? 0) > 0;
}

/** Deletes the tenant's dormant copies of a rejected digest whose snapshot scope `inReach` admits, so the value cannot linger; returns their ids. */
export function purgeDormantByDigest(
  db: DatabaseSyncLike, tenantId: string, digest: string, inReach: (scope: string | null) => boolean,
): string[] {
  // SAFETY: rows' shape matches the three columns named in the SELECT.
  const rows = db.prepare(
    `SELECT id, content, CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.scope') END AS scope
       FROM dormant_memories WHERE tenant_id = ?`,
  ).all(tenantId) as Array<{ id: string; content: string; scope: string | null }>;
  const removed: string[] = [];
  for (const row of rows) {
    if (rejectionDigest(row.content) !== digest || !inReach(row.scope)) continue;
    deleteDormantRow(db, tenantId, row.id);
    removed.push(row.id);
  }
  return removed;
}

export interface DormantKey {
  readonly tenantId: string;
  readonly id: string;
}

export function expiredDormantKeys(db: DatabaseSyncLike, cutoffIso: string): DormantKey[] {
  const sql = `SELECT tenant_id AS tenantId, id FROM dormant_memories WHERE dormant_at < ?`;
  // SAFETY: rows' shape matches the two columns named in the SELECT.
  return db.prepare(sql).all(cutoffIso) as DormantKey[];
}

export function deleteExpiredDormantRow(db: DatabaseSyncLike, key: DormantKey, cutoffIso: string): number {
  const sql = `DELETE FROM dormant_memories WHERE tenant_id = ? AND id = ? AND dormant_at < ?`;
  return Number(db.prepare(sql).run(key.tenantId, key.id, cutoffIso).changes ?? 0);
}
