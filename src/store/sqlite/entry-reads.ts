import { CURRENT_DISTILLED } from '../../db/continuity.js';
import { duplicateHash } from '../../base/util/same-text.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import {
  isFtsAvailable,
  isFtsInSync,
  withReadSnapshot,
  type DatabaseSyncLike,
} from '../../db/index.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry, parseJsonArray } from './rows.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { escapeLike } from '../../base/util/escape.js';
import { scopeAdmitSql } from './rule-sql.js';
import type { SqlFragment } from '../../db/sql.js';
import { chunked } from '../../base/util/chunked.js';
import { byIdOrder, FRESH_RAW_ORDER, oldestFirst, orderSql } from '../rules/order.js';
import { ALL_TENANTS, DEFAULT_TENANT_ID, type TenantId } from '../../base/util/tenant.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../base/util/pages.js';
import { MAX_FRESH_RAW } from '../../base/util/limits.js';
import { tenantAnd, TENANT_IS } from './tenant.js';
import { listEntriesWhere } from './entry-filter.js';
import {
  afterIdAnd,
  entryPage,
  ENTRY_PAGE_ORDER,
  idPageOf,
  type EntryPageRequest,
  type EntryRows,
  type EntryRowsRead,
} from './keyset.js';
import type {
  DuplicateCandidates,
  EntryIdPage,
  HalfLifeRow,
  ObjectLink,
} from '../../base/ports/store/consolidation.js';
import type { IdPage, IdPageRequest } from '../../base/ports/store/vectors.js';
import type { SessionRawCount, SessionRawQuery } from '../../base/ports/store/context-reads.js';
import type { OriginTally } from '../../base/ports/store/project-tags.js';
import type { EntrySignals, EntryTextKeyPage } from '../../base/ports/store/sharing.js';
import type { EntryCursor, EntryPage } from '../../base/ports/store/types.js';

/** Read a memory entry by ID; a row in another tenant reads as null. */
export function readEntry(
  db: DatabaseSyncLike,
  id: string,
  tenantId: TenantId,
): MemoryEntry | null {
  const tenant = tenantAnd(tenantId);
  const row = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ?${tenant.sql}`,
  ).get(id, ...tenant.params) as MemoryRow | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Rows by id on the caller's handle, one query per chunk; an id missing or in another tenant is
 * absent from the map.
 */
export function readEntriesByIds(
  db: DatabaseSyncLike,
  ids: readonly string[],
  tenantId: TenantId,
): Map<string, MemoryEntry> {
  const byId = new Map<string, MemoryEntry>();
  const tenant = tenantAnd(tenantId, TENANT_IS);
  for (const chunk of chunked([...new Set(ids)])) {
    const rows = cachedStatement(
      db,
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (SELECT value FROM json_each(?))${tenant.sql}`,
    ).all(JSON.stringify(chunk), ...tenant.params) as MemoryRow[];
    for (const row of rows) byId.set(row.id, rowToEntry(row));
  }
  return byId;
}

/** Direct children of each parent, one query per chunk; each list is in `created ASC, id ASC`
 * order. */
export function readChildrenByParent(
  db: DatabaseSyncLike,
  parentIds: readonly string[],
  tenantId: TenantId,
): Map<string, MemoryEntry[]> {
  const byParent = new Map<string, MemoryEntry[]>();
  const tenant = tenantAnd(tenantId, TENANT_IS);
  for (const chunk of chunked([...new Set(parentIds)])) {
    const rows = cachedStatement(
      db,
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ` +
        `WHERE dag_parent_id IN (SELECT value FROM json_each(?))${tenant.sql} ORDER BY created ASC, id ASC`,
    ).all(JSON.stringify(chunk), ...tenant.params) as MemoryRow[];
    for (const row of rows) {
      const entry = rowToEntry(row);
      const parentId = entry.dagParentId ?? '';
      const bucket = byParent.get(parentId);
      if (bucket) bucket.push(entry);
      else byParent.set(parentId, [entry]);
    }
  }
  return byParent;
}

/** The rows of every id in `ids`, in the by-id read's order; the rows of one chunk alone cannot
 * be sorted in SQL. */
export function readEntriesInIdOrder(
  db: DatabaseSyncLike,
  ids: readonly string[],
  tenantId: TenantId,
): MemoryEntry[] {
  return [...readEntriesByIds(db, ids, tenantId).values()].sort(byIdOrder);
}

const ORIGIN_IN = 'origin_project IN (SELECT value FROM json_each(?))';

// One JSON param for the list keeps a cached statement's text the same however many origins a
// caller names.
export function originAnd(origins: readonly string[] | null | undefined): SqlFragment {
  if (origins == null) return { sql: '', params: [] };
  return { sql: ` AND (origin_project = '' OR ${ORIGIN_IN})`, params: [JSON.stringify(origins)] };
}

/** A session raw-row read as the port asks it, or across every tenant as the root forms read. */
type SessionRows<Q extends SessionRawQuery> = Omit<Q, 'tenantId'> & { readonly tenantId: TenantId };

/** The WHERE both session raw-row reads share: the session's unsuperseded raw rows in the tenant
 * and origins. */
function sessionRawWhere({
  sessionId,
  tenantId,
  origins,
}: SessionRows<SessionRawQuery>): SqlFragment {
  const tenant = tenantAnd(tenantId);
  const origin = originAnd(origins);
  return {
    sql: `kind = 'raw' AND source_session_id = ? AND superseded_by IS NULL${tenant.sql}${origin.sql}`,
    params: [sessionId, ...tenant.params, ...origin.params],
  };
}

/** Pre-cap, scope-aware row count for a session, so `assemble` reports the full size without
 * leaking rows the caller could not load. Mirrors `passesScopeFilterForRecall`'s default-deny:
 * explicit scope matches exactly, none admits only `ownScope`. */
export function countSessionRawMemories(
  db: DatabaseSyncLike,
  query: SessionRows<SessionRawCount>,
): number {
  if (!query.sessionId) return 0;
  const where = sessionRawWhere(query);
  const { scope, ownScope } = query;
  const admit =
    scope !== undefined && scope !== ''
      ? { sql: 'scope = ?', params: [scope] }
      : scopeAdmitSql('', ownScope);
  const row = cachedStatement(
    db,
    `SELECT COUNT(*) AS c FROM memories WHERE ${where.sql} AND ${admit.sql}`,
  ).get(...where.params, ...admit.params) as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

/** Last N kind='raw' memories by `created` desc, tenant-scoped, at most MAX_FRESH_RAW; pass
 * `sessionId` or concurrent sessions show up in each other's fresh tail. The tenant-wide shape
 * is discouraged: `api.recall` throws `RecallContractError` for it when
 * `HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1`. */
export function listFreshRawMemories(
  db: DatabaseSyncLike,
  count: number,
  tenantId: TenantId,
  sessionId?: string,
  origins?: readonly string[] | null,
): MemoryEntry[] {
  if (count <= 0) return [];
  const capped = Math.min(count, MAX_FRESH_RAW);
  const params: Array<string | number> = [];
  let sql = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' AND superseded_by IS NULL`;
  const tenant = tenantAnd(tenantId);
  sql += tenant.sql;
  params.push(...tenant.params);
  if (sessionId !== undefined && sessionId !== '') {
    sql += ' AND source_session_id = ?';
    params.push(sessionId);
  }
  const origin = originAnd(origins);
  sql += origin.sql;
  params.push(...origin.params);
  sql += ` ORDER BY ${orderSql(FRESH_RAW_ORDER)} LIMIT ?`;
  params.push(capped);
  const rows = cachedStatement(db, sql).all(...params) as MemoryRow[];
  return rows.map(rowToEntry);
}

/** Up to `page.limit` of the tenant's memory ids in loadAllEntries' order, after `page.after`. */
export function listEntryIdsPage(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  page: EntryPageRequest,
): EntryIdPage {
  const { rows, next } = entryPage(
    tenantId,
    page,
    (within, limit) =>
      cachedStatement(
        db,
        `SELECT id, created FROM memories WHERE ${within.match('1')} ${ENTRY_PAGE_ORDER}`,
      ).all(...within.params, limit) as EntryKeyRow[],
  );
  return { ids: rows.map((row) => row.id), next };
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type EntryKeyRow = EntryCursor;

/** Up to `page.limit` memory ids of every tenant in id order after `page.afterId`, off the
 * primary key. */
export function listEveryTenantEntryIds(db: DatabaseSyncLike, page: IdPageRequest): IdPage {
  const after = afterIdAnd(page.afterId);
  const rows = cachedStatement(
    db,
    `SELECT id FROM memories WHERE 1${after.sql} ORDER BY id LIMIT ?`,
  ).all(...after.params, page.limit + 1) as Array<{ id: string }>;
  return idPageOf(rows, page.limit);
}

/** How many memory rows the store holds across every tenant. */
export function countAllEntries(db: DatabaseSyncLike): number {
  const row = cachedStatement(db, 'SELECT COUNT(*) AS c FROM memories').get() as
    | { c?: number }
    | undefined;
  return Number(row?.c ?? 0);
}

// The only code points whose JS toLowerCase yields ASCII, which SQLite's ASCII-only LIKE folding
// cannot see.
const FOLDS_TO_ASCII = ['İ', 'K'];

// Chars or bytes differ only when a non-ASCII char is present; the check never decodes the value.
const hasNonAscii = (column: string): string =>
  `length(${column}) != length(CAST(${column} AS BLOB))`;

/** The FTS5 phrase for `text`: its ASCII alphanumeric runs in order, which is how unicode61
 * splits it; null when it holds none (the phrase would be empty) or any non-ASCII char. */
function ftsPhrase(text: string): string | null {
  if (!/^[ -~]*$/.test(text)) return null;
  const pieces = text.match(/[A-Za-z0-9]+/g);
  return pieces === null ? null : `"${pieces.join(' ')}"`;
}

/** MATCH expression whose hits include every row the LIKE path would keep, or null when some
 * token or the tag has no FTS form. Rows with non-ASCII text are added by the caller: JS
 * tokenizers drop those chars, unicode61 keeps them. */
function ftsMentionQuery(tokens: readonly string[], tag: string | null): string | null {
  const parts: string[] = [];
  for (const t of new Set(tokens)) {
    const phrase = ftsPhrase(t);
    if (phrase === null) return null;
    parts.push(phrase);
  }
  if (tag !== null) {
    const phrase = ftsPhrase(tag);
    if (phrase === null) return null;
    parts.push(`tags : ${phrase}`);
  }
  return parts.length === 0 ? null : parts.join(' OR ');
}

/** A page of a superset, in loadAllEntries' order, of the rows whose lowercased content holds
 * any of `tokens` or whose lowercased tags hold `tag`; `next` is where the following page
 * starts. The caller re-checks each row exactly; this only spares decoding rows that cannot
 * match. */
export function listEntriesMentioning(
  db: DatabaseSyncLike,
  tokens: readonly string[],
  tag: string,
  tenantId: TenantId,
  page: EntryPageRequest,
): EntryPage {
  // A tag needing JSON escapes or case folding past ASCII is not found by a substring of tags_json,
  // so every tagged row stays in.
  const plainTag = /^[ -~]*$/.test(tag) && !/["\\]/.test(tag);
  const ftsQuery =
    plainTag && isFtsAvailable(db) && isFtsInSync(db) ? ftsMentionQuery(tokens, tag) : null;
  if (ftsQuery !== null) {
    return entriesPage(tenantId, page, (within, limit) =>
      ftsMentionRows(db, ftsQuery, within, limit),
    );
  }
  const like = likeMentionFilter(tokens, tag, plainTag);
  return entriesPage(
    tenantId,
    page,
    (within, limit) =>
      cachedStatement(
        db,
        `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${within.match(like.sql)} ${ENTRY_PAGE_ORDER}`,
      ).all(...like.params, ...within.params, limit) as MemoryRow[],
  );
}

/** The LIKE and instr terms that keep every row a mention may match, for a store whose FTS
 * cannot answer. */
function likeMentionFilter(tokens: readonly string[], tag: string, plainTag: boolean): SqlFragment {
  const likes = [...new Set(tokens)].map((t) => `%${escapeLike(t)}%`);
  const clauses = likes.map(() => `content LIKE ? ESCAPE '\\'`);
  const params: string[] = [...likes];
  if (plainTag) {
    clauses.push(`tags_json LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(tag)}%`);
  } else clauses.push(`COALESCE(tags_json, '[]') != '[]'`);
  for (const ch of FOLDS_TO_ASCII) {
    clauses.push('instr(content, ?) > 0', 'instr(tags_json, ?) > 0');
    params.push(ch, ch);
  }
  return { sql: clauses.join(' OR '), params };
}

// The plus keeps SQLite on the tenant's created index: on the id key it would fetch and sort every
// hit for each page.
const FTS_HITS = '+id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?)';
const NON_ASCII_ROWS = `(${hasNonAscii('content')} OR ${hasNonAscii('tags_json')})`;

// Two reads, not one OR, so only the non-ASCII read decodes each row's text, and with a full page
// of hits it stops at the last hit, past which no row can make the page.
function ftsMentionRows(
  db: DatabaseSyncLike,
  ftsQuery: string,
  within: EntryRows,
  limit: number,
): MemoryRow[] {
  const hits = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${within.match(FTS_HITS)} ${ENTRY_PAGE_ORDER}`,
  ).all(ftsQuery, ...within.params, limit) as MemoryRow[];
  const last = hits.length === limit ? hits[limit - 1] : undefined;
  const upTo =
    last === undefined
      ? { sql: '', params: [] }
      : { sql: ' AND created <= ?', params: [last.created] };
  const nonAscii = within.match(NON_ASCII_ROWS + upTo.sql);
  const others = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${nonAscii} ${ENTRY_PAGE_ORDER}`,
  ).all(...upTo.params, ...within.params, limit) as MemoryRow[];
  const ids = new Set(hits.map((row) => row.id));
  return [...hits, ...others.filter((row) => !ids.has(row.id))].sort(oldestFirst).slice(0, limit);
}

/** entryPage over whole rows, decoded. */
function entriesPage(
  tenantId: TenantId,
  page: EntryPageRequest,
  read: EntryRowsRead<MemoryRow>,
): EntryPage {
  const { rows, next } = entryPage(tenantId, page, read);
  return { entries: rows.map(rowToEntry), next };
}

/** A page of rows in loadAllEntries' order, with only the columns that say whether another store
 * already holds each. */
export function listEntryTextKeysPage(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  page: EntryPageRequest,
): EntryTextKeyPage {
  const { rows, next } = entryPage(
    tenantId,
    page,
    (within, limit) =>
      cachedStatement(
        db,
        `SELECT id, tenant_id, content, source, created FROM memories WHERE ${within.match('1')} ${within.order}`,
      ).all(...within.params, limit) as EntryTextKeyPageRow[],
  );
  const keys = rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id ?? DEFAULT_TENANT_ID,
    content: row.content,
    source: row.source,
  }));
  return { keys, next };
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface EntryTextKeyPageRow {
  id: string;
  tenant_id: string | null;
  content: string;
  source: string;
  created: string;
}

/** Every tenant's rows in loadAllEntries' order, so the caller holds one page at a time. */
export function iterateEveryTenantEntries(db: DatabaseSyncLike): Generator<MemoryEntry> {
  return rowsInPages((after?: EntryCursor) =>
    listEntriesWhere(db, { tenantId: ALL_TENANTS }, { limit: READ_PAGE_ROWS, after }),
  );
}

/** The columns a text match needs, for one row of a tenant. */
// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface TenantText {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly scope: string | null;
}

/** One page of TenantText rows, and where the next page starts (null after the last). */
interface TenantTextPage {
  readonly texts: TenantText[];
  readonly next: EntryCursor | null;
}

/** A page of a tenant's rows in loadAllEntries' order with the columns a text match needs:
 * callers read whole rows only for the ids that match. */
export function listTenantTextsPage(
  db: DatabaseSyncLike,
  tenantId: string,
  page: EntryPageRequest,
): TenantTextPage {
  const { rows, next } = entryPage(
    tenantId,
    page,
    (within, limit) =>
      cachedStatement(
        db,
        `SELECT id, content, source, scope, created FROM memories WHERE ${within.match('1')} ${ENTRY_PAGE_ORDER}`,
      ).all(...within.params, limit) as Array<TenantText & { created: string }>,
  );
  return { texts: rows, next };
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type OriginTallyDbRow = OriginTally;

/** Each project name's live rows in one grouped read, in the order its first row comes in
 * loadAllEntries' order. */
export function countByOrigin(
  db: DatabaseSyncLike,
  tenantId: string,
  sourcePrefix: string,
): OriginTally[] {
  // The unit separator sorts below every character of a time or an id, so the joined string orders
  // as (created, id).
  return cachedStatement(
    db,
    `SELECT origin_project AS origin, COUNT(*) AS live, SUM(substr(source, 1, ?) = ?) AS prefixed, ` +
      `MAX(created) AS newest FROM memories WHERE tenant_id = ? AND COALESCE(superseded_by, '') = '' ` +
      `GROUP BY origin_project ORDER BY MIN(created || char(31) || id)`,
  ).all(sourcePrefix.length, sourcePrefix, tenantId) as OriginTallyDbRow[];
}

/** The ids among `ids` that a row of any tenant holds, one query per chunk. */
export function readTakenIds(db: DatabaseSyncLike, ids: readonly string[]): string[] {
  const taken: string[] = [];
  for (const chunk of chunked([...new Set(ids)])) {
    const rows = cachedStatement(
      db,
      `SELECT id FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(chunk)) as Array<{ id: string }>;
    for (const row of rows) taken.push(row.id);
  }
  return taken;
}

// Content of every team-visible tenant row tagged `tag`, without reading the rest of the store;
// `origins` keeps one project's rows and user-global ones. No owner: a personal or
// connector-private row must never answer `duplicate` for, or stop, a team copy. `instr`
// prefilters; `includes` re-checks.
export function contentsWithTag(
  db: DatabaseSyncLike,
  tenantId: string,
  tag: string,
  origins?: readonly string[],
): string[] {
  const inProject = originAnd(origins);
  const admit = scopeAdmitSql('');
  /** SAFETY: rows' shape matches the two columns named in the SELECT below. */
  const rows = cachedStatement(
    db,
    `SELECT content, tags_json FROM memories WHERE tenant_id = ? ` +
      `AND instr(tags_json, ?) > 0${inProject.sql} AND ${admit.sql}`,
  ).all(tenantId, JSON.stringify(tag), ...inProject.params, ...admit.params) as Array<{
    content: string;
    tags_json: string;
  }>;
  return rows.filter((r) => parseJsonArray(r.tags_json).includes(tag)).map((r) => r.content);
}

export interface PreviewRow {
  id: string;
  content: string;
  source: string | null;
  confidence: MemoryEntry['confidence'] | null;
  extracted_from: string | null;
  dag_level: number | null;
  tags_json: string | null;
}

/** A page of memories, by rowid, from a store whose schema may predate some columns; `columns`
 * is the table's real column set, and every schema has a rowid. */
export function listPreviewRowsPage(
  db: DatabaseSyncLike,
  columns: ReadonlySet<string>,
  tenantId: string,
  page: { readonly limit: number; readonly afterRowid: number },
): Array<PreviewRow & { row_id: number }> {
  const tenant = columns.has('tenant_id') ? ' AND tenant_id = ?' : '';
  const column = (name: string, fallback: string): string =>
    columns.has(name) ? name : `${fallback} AS ${name}`;
  const statement = cachedStatement(
    db,
    `SELECT rowid AS row_id, id, content, ${column('source', "''")}, ` +
      `${column('confidence', 'NULL')}, ${column('extracted_from', 'NULL')}, ` +
      `${column('dag_level', '0')}, ${column('tags_json', "'[]'")} FROM memories ` +
      `WHERE rowid > ?${tenant} ORDER BY rowid LIMIT ?`,
  );
  const args = tenant ? [page.afterRowid, tenantId, page.limit] : [page.afterRowid, page.limit];
  // SAFETY: the SELECT names the rowid and every PreviewRow field, each a literal fallback when its
  // column is missing.
  return statement.all(...args) as Array<PreviewRow & { row_id: number }>;
}

/** True when a memory row, of any tenant, already holds `id`. */
export function entryIdTaken(db: DatabaseSyncLike, id: string): boolean {
  return cachedStatement(db, `SELECT 1 FROM memories WHERE id = ?`).get(id) !== undefined;
}

/** The text, tenant and scope of memory `id`, or undefined when no row holds it. */
export function entryRejectRow(
  db: DatabaseSyncLike,
  id: string,
): { content: string; tenant_id: string; scope: string | null } | undefined {
  return cachedStatement(db, `SELECT content, tenant_id, scope FROM memories WHERE id = ?`).get(
    id,
  ) as { content: string; tenant_id: string; scope: string | null } | undefined;
}

/** The typed-object tables whose rows name a backing memory in `memory_id`. */
const OBJECT_TABLES = [
  'decisions',
  'incidents',
  'processes',
  'policies',
  'skills',
  'project_briefs',
  'customer_notes',
] as const;

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

/** A page of the rows holding at least one signal, in loadAllEntries' order. A superset: callers
 * re-check each row. */
export function listEntriesWithSignals(
  db: DatabaseSyncLike,
  signals: EntrySignals,
  tenantId: TenantId,
  page: EntryPageRequest,
): EntryPage {
  // A backslash may hide an escaped tag from instr, so such rows always pass; LIKE folds case, so
  // the prefix match is wider than startsWith.
  const anyOf = [
    'pinned != 0',
    'retrieval_count >= ?',
    'emotional_valence IN (SELECT value FROM json_each(?))',
    "source LIKE ? ESCAPE '\\'",
    "instr(tags_json, '\\') > 0",
    'EXISTS (SELECT 1 FROM json_each(?) AS tag WHERE instr(tags_json, tag.value) > 0)',
  ];
  const params = [
    signals.minRetrievals,
    JSON.stringify(signals.valences),
    `${escapeLike(signals.sourcePrefix)}%`,
    JSON.stringify(signals.tags.map((t) => JSON.stringify(t))),
  ];
  return entriesPage(
    tenantId,
    page,
    (within, limit) =>
      cachedStatement(
        db,
        `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE ${within.match(anyOf.join(' OR '))} ${within.order}`,
      ).all(...params, ...within.params, limit) as MemoryRow[],
  );
}
