// The rejection keys of each stored text: a row's own digest in rejection_digest and the others in
// held_text_digests, so a rejection reads the rows that may hold a value by index, not the tenant.
import { cachedStatement } from '../../db/statement-cache.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { otherDigests, rejectionDigest } from '../../base/records/rejection-digest.js';
import { chunked } from '../../base/util/chunked.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';

/** The table a row sits in: memories, or dormant_memories. */
export type Place = 'live' | 'dormant';

/** A row's stored text and its key. */
export interface KeyedText {
  readonly tenantId: string;
  readonly id: string;
  readonly content: string;
}

type HeldKey = [tenantId: string, digest: string, id: string];

const TABLE = { live: 'memories', dormant: 'dormant_memories' } as const;
const IN_DORMANT = { live: 0, dormant: 1 } as const;

// The owner check keeps a key from naming a row the write did not leave in the table.
function keysInsert(place: Place): string {
  return (
    `INSERT OR IGNORE INTO held_text_digests(tenant_id, rejection_digest, in_dormant, memory_id) ` +
    `SELECT json_extract(k.value, '$[0]'), json_extract(k.value, '$[1]'), ${IN_DORMANT[place]}, ` +
    `json_extract(k.value, '$[2]') FROM json_each(?) AS k WHERE EXISTS (SELECT 1 FROM ${TABLE[place]} t ` +
    `WHERE t.tenant_id = json_extract(k.value, '$[0]') AND t.id = json_extract(k.value, '$[2]'))`
  );
}

const INSERT_KEYS = { live: keysInsert('live'), dormant: keysInsert('dormant') } as const;

function heldKeys(rows: readonly KeyedText[]): HeldKey[] {
  return rows.flatMap((row) =>
    otherDigests(row.content).map((digest): HeldKey => [row.tenantId, digest, row.id]),
  );
}

function insertKeys(db: DatabaseSyncLike, place: Place, keys: readonly HeldKey[]): void {
  for (const chunk of chunked(keys)) {
    cachedStatement(db, INSERT_KEYS[place]).run(JSON.stringify(chunk));
  }
}

/** Runs `write`, which writes `rows` to `place` with their digests, then their held keys, in one
 * write scope; rows with no held keys cost no scope and no statement. */
export function withHeldDigests<T>(
  db: DatabaseSyncLike,
  place: Place,
  rows: readonly KeyedText[],
  write: () => T,
): T {
  const keys = heldKeys(rows);
  if (keys.length === 0) return write();
  return withWriteScope(db, 'held_digests', () => {
    const written = write();
    insertKeys(db, place, keys);
    return written;
  });
}

// SAFETY: every read cast to this row selects id; scripts/check-row-casts.mjs proves it.
interface IdRow {
  readonly id: string;
}

// SAFETY: every read cast to this row selects k and id; scripts/check-row-casts.mjs proves it.
interface KeyedIdRow {
  readonly k: string | number;
  readonly id: string;
}

function matchedSql(place: Place): string {
  return (
    `SELECT id FROM ${TABLE[place]} WHERE rejection_digest = ? AND tenant_id = ? UNION ` +
    `SELECT memory_id AS id FROM held_text_digests ` +
    `WHERE tenant_id = ? AND rejection_digest = ? AND in_dormant = ${IN_DORMANT[place]}`
  );
}

const MATCHED_SQL = { live: matchedSql('live'), dormant: matchedSql('dormant') } as const;

// memories pages by rowid, which its digest index keeps in order; dormant_memories has no rowid.
const UNFILLED_PAGE_SQL = {
  live:
    `SELECT rowid AS k, id FROM memories WHERE rejection_digest IS NULL AND tenant_id = ? ` +
    `AND rowid > ? ORDER BY rowid LIMIT ?`,
  dormant:
    `SELECT id AS k, id FROM dormant_memories WHERE rejection_digest IS NULL AND tenant_id = ? ` +
    `AND id > ? ORDER BY id LIMIT ?`,
} as const;
const FIRST_KEY = { live: Number.MIN_SAFE_INTEGER, dormant: '' } as const;

/** Pages of at most READ_PAGE_ROWS ids of a tenant's rows in `place` that may hold the text
 * `digest` names: the rows keyed by it, then the unfilled rows by keyset. `skip` ids never come. */
export function* digestHolderIds(
  db: DatabaseSyncLike,
  place: Place,
  query: { readonly tenantId: string; readonly digest: string },
  skip: ReadonlySet<string> = new Set(),
): Generator<string[]> {
  const { tenantId, digest } = query;
  // SAFETY: both arms of matchedSql answer one TEXT column named id.
  const matched = (
    cachedStatement(db, MATCHED_SQL[place]).all(digest, tenantId, tenantId, digest) as IdRow[]
  )
    .map((row) => row.id)
    .filter((id) => !skip.has(id));
  yield* chunked(matched, READ_PAGE_ROWS);
  const seen = new Set([...skip, ...matched]);
  let after: string | number = FIRST_KEY[place];
  for (;;) {
    // SAFETY: each UNFILLED_PAGE_SQL selects k and id.
    const page = cachedStatement(db, UNFILLED_PAGE_SQL[place]).all(
      tenantId,
      after,
      READ_PAGE_ROWS,
    ) as KeyedIdRow[];
    const ids = page.map((row) => row.id).filter((id) => !seen.has(id));
    if (ids.length > 0) yield ids;
    if (page.length < READ_PAGE_ROWS) return;
    after = page[page.length - 1].k;
  }
}

// SAFETY: every read cast to this row selects k, tenant_id, id and content;
// scripts/check-row-casts.mjs proves it.
interface UnfilledRow {
  readonly k: string | number;
  readonly tenant_id: string;
  readonly id: string;
  readonly content: string;
}

const KEY_COLUMN = { live: 'rowid', dormant: 'id' } as const;

/** The fill's three statements for one place. */
interface FillSql {
  readonly read: string;
  readonly dropKeys: string;
  readonly setDigests: string;
}

function fillSql(place: Place): FillSql {
  const table = TABLE[place];
  return {
    read:
      `SELECT ${KEY_COLUMN[place]} AS k, tenant_id, id, content FROM ${table} ` +
      `WHERE rejection_digest IS NULL LIMIT ?`,
    dropKeys:
      `DELETE FROM held_text_digests WHERE in_dormant = ${IN_DORMANT[place]} AND (tenant_id, memory_id) IN ` +
      `(SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`,
    setDigests:
      `UPDATE ${table} SET rejection_digest = json_extract(v.value, '$[2]') FROM json_each(?) AS v ` +
      `WHERE ${table}.tenant_id = json_extract(v.value, '$[0]') ` +
      `AND ${table}.${KEY_COLUMN[place]} = json_extract(v.value, '$[1]')`,
  };
}

const FILL_SQL = { live: fillSql('live'), dormant: fillSql('dormant') } as const;

/** Keys up to READ_PAGE_ROWS unfilled rows of `place` in one write scope: drops their held keys,
 * writes the ones their text gives, then sets the digest. Returns the rows it read. */
function fillPage(db: DatabaseSyncLike, place: Place): number {
  const sql = FILL_SQL[place];
  return withWriteScope(db, 'fill_rejection_digests', () => {
    // SAFETY: fillSql's read selects k, tenant_id, id and content.
    const rows = cachedStatement(db, sql.read).all(READ_PAGE_ROWS) as UnfilledRow[];
    if (rows.length === 0) return 0;
    const owners = rows.map((row) => [row.tenant_id, row.id]);
    cachedStatement(db, sql.dropKeys).run(JSON.stringify(owners));
    const texts = rows.map((row) => ({
      tenantId: row.tenant_id,
      id: row.id,
      content: row.content,
    }));
    insertKeys(db, place, heldKeys(texts));
    const digests = rows.map((row) => [row.tenant_id, row.k, rejectionDigest(row.content)]);
    cachedStatement(db, sql.setDigests).run(JSON.stringify(digests));
    return rows.length;
  });
}

/** Keys every row of hippo.db that has no digest, a page per write scope so none holds the lock
 * long; it stops at the count it read first. Returns the rows keyed. */
export function fillRejectionDigests(db: DatabaseSyncLike): number {
  let filled = 0;
  for (const place of ['live', 'dormant'] as const) {
    // SAFETY: an aggregate with no GROUP BY always answers one row.
    const { n } = cachedStatement(
      db,
      `SELECT COUNT(*) AS n FROM ${TABLE[place]} WHERE rejection_digest IS NULL`,
    ).get() as { n: number };
    for (let done = 0; done < n;) {
      const read = fillPage(db, place);
      done += read;
      filled += read;
      if (read < READ_PAGE_ROWS) break;
    }
  }
  return filled;
}
