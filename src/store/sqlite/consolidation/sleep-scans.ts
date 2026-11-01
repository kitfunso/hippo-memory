// The scans sleep runs over every memory: object-backed rows and duplicate candidates.

import { CURRENT_DISTILLED } from '../../../db/sql.js';
import { duplicateHash } from '../../../base/util/same-text.js';
import { withReadSnapshot, type DatabaseSyncLike } from '../../../db/index.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from '../runtime/rows.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { KINDS } from '../records/object-rows.js';
import { chunked } from '../../../base/util/chunked.js';
import { DEFAULT_TENANT_ID } from '../../../base/util/tenant.js';
import type {
  DuplicateCandidates,
  HalfLifeRow,
  ObjectLink,
} from '../../../base/records/consolidation.js';

/** The typed-object tables whose rows name a backing memory in `memory_id`. */
const OBJECT_TABLES = Object.values(KINDS).map((kind) => kind.table);

const backsObject = (statuses: string): string =>
  OBJECT_TABLES.map(
    (t) => `EXISTS (SELECT 1 FROM ${t} WHERE ${t}.memory_id = memories.id${statuses})`,
  ).join(' OR ');

// Each table's partial memory_id index answers the EXISTS, so no object table is read whole.
const OBJECT_LINK_SQL =
  `CASE WHEN ${backsObject(" AND status IN ('superseded', 'closed')")} THEN 'retired' ` +
  `WHEN ${backsObject('')} THEN 'live' END`;

// SAFETY: every read cast to this row selects MEMORY_SELECT_COLUMNS and object_link.
type ObjectLinkedRow = MemoryRow & { object_link: ObjectLink };

/** Every tenant's rows in loadAllEntries' order through one cursor, each with the typed object
 * it backs. */
export function* iterateRowsWithObjects(db: DatabaseSyncLike): Generator<HalfLifeRow> {
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS}, ${OBJECT_LINK_SQL} AS object_link FROM memories ORDER BY created ASC, id ASC`,
  ).iterate() as Iterable<ObjectLinkedRow>;
  for (const row of rows) yield { entry: rowToEntry(row), object: row.object_link };
}

// Hashes per page of the duplicate read; each page reads its hashes' rows by
// idx_memories_duplicate_hash.
const DUPLICATE_KEYS_PAGE = 500;

/** The current distilled rows that may be another's duplicate, and the partitions in the order
 * they first appear. */
export function listDuplicateCandidates(db: DatabaseSyncLike): DuplicateCandidates {
  // One read transaction, so the partition keys describe the rows read.
  return withReadSnapshot(db, () => {
    // An older binary's rows carry no hash: hash them here, and read the hashed rows that share
    // one. The caller regroups by duplicateKey, so a hash two different texts share costs only a
    // row read. SAFETY: MEMORY_SELECT_COLUMNS selects every MemoryRow key.
    const rows = cachedStatement(
      db,
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${CURRENT_DISTILLED} AND duplicate_hash IS NULL`,
    ).all() as MemoryRow[];
    const unread = new Set(rows.map((row) => duplicateHash(row.content)));
    for (let after = -1; ;) {
      // SAFETY: the SELECT names one INTEGER column, k.
      const keys = cachedStatement(
        db,
        `SELECT duplicate_hash AS k FROM memories WHERE ${CURRENT_DISTILLED} AND duplicate_hash > ? ` +
          `GROUP BY duplicate_hash HAVING COUNT(*) > 1 ORDER BY duplicate_hash LIMIT ?`,
      ).all(after, DUPLICATE_KEYS_PAGE) as Array<{ k: number }>;
      for (const key of keys) unread.delete(key.k);
      rows.push(
        ...rowsWithHashes(
          db,
          keys.map((key) => key.k),
        ),
      );
      if (keys.length < DUPLICATE_KEYS_PAGE) break;
      after = keys[keys.length - 1]!.k;
    }
    for (const hashes of chunked([...unread], DUPLICATE_KEYS_PAGE)) {
      rows.push(...rowsWithHashes(db, hashes));
    }
    // Pages come in hash order; the port's order is created then id, as SQLite compares the ASCII
    // stamps and ids.
    rows.sort(byCreatedThenId);
    return { rows: rows.map(rowToEntry), firstSeen: firstSeenPartitions(db) };
  });
}

function rowsWithHashes(db: DatabaseSyncLike, hashes: readonly number[]): MemoryRow[] {
  if (hashes.length === 0) return [];
  // SAFETY: MEMORY_SELECT_COLUMNS selects every MemoryRow key.
  return cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ` +
      `WHERE ${CURRENT_DISTILLED} AND duplicate_hash IN (SELECT value FROM json_each(?))`,
  ).all(JSON.stringify(hashes)) as MemoryRow[];
}

const byCreatedThenId = (a: MemoryRow, b: MemoryRow): number =>
  a.created === b.created ? (a.id < b.id ? -1 : 1) : a.created < b.created ? -1 : 1;

/** Each (tenant, scope, origin) of a current distilled row, in the order its first row appears
 * by created then id. */
function firstSeenPartitions(db: DatabaseSyncLike): DuplicateCandidates['firstSeen'] {
  // SAFETY: every read cast to this row selects all its keys. The ORDER BY ranks in SQL, the order
  // the rows sort in.
  const firsts = cachedStatement(
    db,
    `SELECT tenant_id, scope, origin_project FROM memories WHERE ${CURRENT_DISTILLED} ` +
      `GROUP BY tenant_id, scope, origin_project ORDER BY MIN(created || char(31) || id)`,
  ).all() as Array<{
    tenant_id: string | null;
    scope: string | null;
    origin_project: string | null;
  }>;
  return firsts.map((f) => ({
    tenantId: f.tenant_id ?? DEFAULT_TENANT_ID,
    scope: f.scope,
    originProject: f.origin_project,
  }));
}
