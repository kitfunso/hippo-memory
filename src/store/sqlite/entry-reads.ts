import type { MemoryEntry } from '../../core/memory.js';
import { isFtsAvailable, isFtsInSync, type DatabaseSyncLike } from '../../db/index.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry, parseJsonArray } from './rows.js';
import { cachedStatement } from './statement-cache.js';
import { escapeLike } from '../../util/escape.js';
import { originInSql } from '../../core/project-identity.js';
import { scopeAdmitSql } from './rule-sql.js';
import { chunked } from '../../util/chunked.js';
import { ALL_TENANTS, DEFAULT_TENANT_ID, type TenantId } from '../../util/tenant.js';
import { placeholders } from '../../util/sql.js';
import { duplicateKey, longestWord } from '../../util/same-text.js';
import { tenantAnd } from './tenant.js';
import type { EntryCursor, EntryIdPage, EntryPage } from '../port/consolidation.js';
import type { RawRefRow } from '../port/context-reads.js';
import type { OriginRows, OriginTally } from '../port/project-tags.js';
import type { EntrySignals, EntryTextKey, EntryTextKeyPage } from '../port/sharing.js';

const MAX_IDS_PER_READ = 500;
const MAX_FRESH_RAW = 200;

// The plus keeps SQLite on the primary key for an id list: with
// a bare tenant_id it walks every row of the tenant instead.
export const TENANT_IS = '+tenant_id = ?';

/** Read a memory entry by ID; a row in another tenant reads as null. */
export function readEntryAt(db: DatabaseSyncLike, id: string, tenantId: TenantId): MemoryEntry | null {
  const tenant = tenantAnd(tenantId);
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const row = db
    .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ?${tenant.sql}`)
    .get(id, ...tenant.args) as MemoryRow | undefined;
  return row ? rowToEntry(row) : null;
}

/** Rows by id on the caller's handle, one query per chunk; an
 * id missing or in another tenant is absent from the map. */
export function selectEntriesByIds(
  db: DatabaseSyncLike,
  ids: readonly string[],
  tenantId: TenantId,
): Map<string, MemoryEntry> {
  const byId = new Map<string, MemoryEntry>();
  const tenant = tenantAnd(tenantId, TENANT_IS);
  for (const chunk of chunked([...new Set(ids)])) {
    const marks = placeholders(chunk.length);
    // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const rows = cachedStatement(
      db,
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${marks})${tenant.sql}`,
    ).all(...chunk, ...tenant.args) as MemoryRow[];
    for (const row of rows) byId.set(row.id, rowToEntry(row));
  }
  return byId;
}

/** Direct children of each parent, one query per chunk; each list is in `created ASC, id ASC` order. */
export function selectChildrenByParent(
  db: DatabaseSyncLike,
  parentIds: readonly string[],
  tenantId: TenantId,
): Map<string, MemoryEntry[]> {
  const byParent = new Map<string, MemoryEntry[]>();
  const tenant = tenantAnd(tenantId, TENANT_IS);
  for (const chunk of chunked([...new Set(parentIds)])) {
    const marks = placeholders(chunk.length);
    // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const rows = cachedStatement(
      db,
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ` +
        `WHERE dag_parent_id IN (${marks})${tenant.sql} ORDER BY created ASC, id ASC`,
    ).all(...chunk, ...tenant.args) as MemoryRow[];
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

/** Batched lookup, capped at 500 ids per call to keep IN(?,?,...) within SQLite limits. */
export function loadEntriesByIdsAt(db: DatabaseSyncLike, ids: readonly string[], tenantId: TenantId): MemoryEntry[] {
  if (ids.length === 0) return [];
  const capped = ids.slice(0, MAX_IDS_PER_READ);
  const tenant = tenantAnd(tenantId, TENANT_IS);
  // Without ORDER BY, rows follow SQLite's IN(...) scan order, undefined w.r.t. `ids`.
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders(capped.length)})${tenant.sql} ` +
      `ORDER BY created ASC, content ASC, id ASC`,
  ).all(...capped, ...tenant.args) as MemoryRow[];
  return rows.map(rowToEntry);
}

function originClause(origins: readonly string[] | undefined): string {
  return origins === undefined ? '' : ` AND (origin_project = '' OR ${originInSql(origins)})`;
}

/** All `kind='raw'` rows for a session, tenant-scoped, oldest-first, excluding superseded; `[]` for an empty sessionId.
 * With `cap`, the NEWEST rows are loaded (DESC LIMIT, reversed client-side); ASC + LIMIT would drop the newest and
 * break fresh-tail in assemble. */
export function loadSessionRawMemoriesAt(
  db: DatabaseSyncLike,
  sessionId: string,
  tenantId: TenantId,
  cap?: number,
  origins?: readonly string[],
): MemoryEntry[] {
  if (!sessionId) return [];
  const params: Array<string | number> = [];
  let sql =
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' ` +
    `AND source_session_id = ? AND superseded_by IS NULL`;
  params.push(sessionId);
  const tenant = tenantAnd(tenantId);
  sql += tenant.sql;
  params.push(...tenant.args);
  sql += originClause(origins);
  params.push(...(origins ?? []));
  if (cap !== undefined && cap > 0) {
    sql += ' ORDER BY created DESC, id DESC LIMIT ?';
    params.push(cap);
    // SAFETY: sql starts from MEMORY_SELECT_COLUMNS, matching MemoryRow.
    const rows = db.prepare(sql).all(...params) as MemoryRow[];
    return rows.reverse().map(rowToEntry);
  }
  sql += ' ORDER BY created ASC, id ASC';
  // SAFETY: sql starts from MEMORY_SELECT_COLUMNS, matching MemoryRow.
  const rows = db.prepare(sql).all(...params) as MemoryRow[];
  return rows.map(rowToEntry);
}

/** Pre-cap, scope-aware row count for a session, so `assemble` reports the full size without leaking rows the caller
 * could not load. Mirrors
 * `passesScopeFilterForRecall`'s default-deny: explicit scope matches exactly, none admits only `ownScope`. */
export function countSessionRawMemoriesAt(
  db: DatabaseSyncLike,
  sessionId: string,
  tenantId: TenantId,
  scope?: string,
  ownScope?: string,
  origins?: readonly string[],
): number {
  if (!sessionId) return 0;
  const params: Array<string> = [];
  let sql =
    `SELECT COUNT(*) AS c FROM memories WHERE kind = 'raw' ` + `AND source_session_id = ? AND superseded_by IS NULL`;
  params.push(sessionId);
  const tenant = tenantAnd(tenantId);
  sql += tenant.sql;
  params.push(...tenant.args);
  sql += originClause(origins);
  params.push(...(origins ?? []));
  if (scope !== undefined && scope !== '') {
    sql += ' AND scope = ?';
    params.push(scope);
  } else {
    const admit = scopeAdmitSql('', ownScope);
    sql += ` AND ${admit.sql}`;
    params.push(...admit.params);
  }
  // SAFETY: row's shape matches the single `COUNT(*) AS c` column above.
  const row = db.prepare(sql).get(...params) as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

/** Last N kind='raw' memories by `created` desc, tenant-scoped, max 200; pass
 * `sessionId` or concurrent sessions show up in each other's fresh tail. The
 * tenant-wide shape is discouraged: `api.recall` throws `RecallContractError`
 * for it when `HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1`. */
export function loadFreshRawMemoriesAt(
  db: DatabaseSyncLike,
  count: number,
  tenantId: TenantId,
  sessionId?: string,
  origins?: readonly string[],
): MemoryEntry[] {
  if (count <= 0) return [];
  const capped = Math.min(count, MAX_FRESH_RAW);
  const params: Array<string | number> = [];
  let sql = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' AND superseded_by IS NULL`;
  const tenant = tenantAnd(tenantId);
  sql += tenant.sql;
  params.push(...tenant.args);
  if (sessionId !== undefined && sessionId !== '') {
    sql += ' AND source_session_id = ?';
    params.push(sessionId);
  }
  sql += originClause(origins);
  params.push(...(origins ?? []));
  // Tie tail makes same-`created` rows deterministic; `content` before `id` because ids are random
  // UUIDs, so an id-only tail would pick which same-created rows make the window per instance.
  sql += ' ORDER BY created DESC, content ASC, id ASC LIMIT ?';
  params.push(capped);
  // SAFETY: sql starts from MEMORY_SELECT_COLUMNS, matching MemoryRow.
  const rows = db.prepare(sql).all(...params) as MemoryRow[];
  return rows.map(rowToEntry);
}

/** Every entry of one tenant. A caller that surfaces rows to a user passes the resolved tenant. */
export function loadAllEntriesAt(db: DatabaseSyncLike, tenantId: string): MemoryEntry[] {
  return selectAllRows(db, tenantId).map(rowToEntry);
}

/** Up to `page.limit` of the tenant's memory ids in loadAllEntries' order, after `page.after`. Two short columns per
 * row: no index orders memories by created then id across tenants, so each page sorts the ids again. */
export function loadEntryIdsPageAt(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  page: { readonly limit: number; readonly after?: EntryCursor },
): EntryIdPage {
  const tenant = tenantAnd(tenantId);
  const after = afterCursor(page.after);
  // SAFETY: rows' shape matches the two columns named in the SELECT.
  const rows = cachedStatement(
    db,
    `SELECT id, created FROM memories WHERE 1${tenant.sql}${after.sql} ORDER BY created ASC, id ASC LIMIT ?`,
  ).all(...tenant.args, ...after.args, page.limit + 1) as Array<{ id: string; created: string }>;
  return { ids: rows.slice(0, page.limit).map((row) => row.id), next: cursorAfter(rows, page.limit) };
}

/** How many memory rows the store holds across every tenant. */
export function countAllEntriesAt(db: DatabaseSyncLike): number {
  // SAFETY: row's shape matches the single `COUNT(*) AS c` column.
  const row = db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c?: number } | undefined;
  return Number(row?.c ?? 0);
}

// The only code points whose JS toLowerCase yields ASCII, which SQLite's ASCII-only LIKE folding cannot see.
const FOLDS_TO_ASCII = ['İ', 'K'];

// Chars or bytes differ only when a non-ASCII char is present; the check never decodes the value.
const hasNonAscii = (column: string): string => `length(${column}) != length(CAST(${column} AS BLOB))`;

/** The FTS5 phrase for `text`: its ASCII alphanumeric runs in order, which is how unicode61 splits it; null when it
 * holds none (the phrase would be empty) or any non-ASCII char. */
function ftsPhrase(text: string): string | null {
  if (!/^[ -~]*$/.test(text)) return null;
  const pieces = text.match(/[A-Za-z0-9]+/g);
  return pieces === null ? null : `"${pieces.join(' ')}"`;
}

/** MATCH expression whose hits include every row the LIKE path would keep, or null when some token or the tag has no
 * FTS form. Rows with non-ASCII text are added by the caller: JS tokenizers drop those chars, unicode61 keeps them. */
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

/** A page of a superset, in loadAllEntries' order, of the rows whose lowercased content holds any of `tokens` or whose
 * lowercased tags hold `tag`; `next` is where the following page starts.
 * The caller re-checks each row exactly; this only spares decoding rows that cannot match. */
export function loadEntriesMentioningAt(
  db: DatabaseSyncLike,
  tokens: readonly string[],
  tag: string,
  tenantId: TenantId,
  page: { readonly limit: number; readonly after?: EntryCursor },
): EntryPage {
  const likes = [...new Set(tokens)].map((t) => `%${escapeLike(t)}%`);
  const clauses = likes.map(() => `content LIKE ? ESCAPE '\\'`);
  const params: string[] = [...likes];
  // A tag needing JSON escapes or case folding past ASCII is not
  // found by a substring of tags_json, so every tagged row stays in.
  const plainTag = /^[ -~]*$/.test(tag) && !/["\\]/.test(tag);
  if (plainTag) {
    clauses.push(`tags_json LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(tag)}%`);
  } else clauses.push(`COALESCE(tags_json, '[]') != '[]'`);
  for (const ch of FOLDS_TO_ASCII) {
    clauses.push('instr(content, ?) > 0', 'instr(tags_json, ?) > 0');
    params.push(ch, ch);
  }
  const tenant = tenantAnd(tenantId);
  const ftsQuery = plainTag && isFtsAvailable(db) && isFtsInSync(db) ? ftsMentionQuery(tokens, tag) : null;
  const where =
    ftsQuery === null
      ? clauses.join(' OR ')
      : `id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?) OR ${hasNonAscii('content')} OR ` +
        hasNonAscii('tags_json');
  const afterClause = page.after ? ' AND (created > ? OR (created = ? AND id > ?))' : '';
  const afterParams = page.after ? [page.after.created, page.after.created, page.after.id] : [];
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ` +
        `WHERE (${where})${tenant.sql}${afterClause} ORDER BY created ASC, id ASC LIMIT ?`,
    )
    // One extra row says whether another page follows without a count.
    .all(...(ftsQuery === null ? params : [ftsQuery]), ...tenant.args, ...afterParams, page.limit + 1) as MemoryRow[];
  return pageOf(rows.map(rowToEntry), page.limit);
}

function pageOf(rows: MemoryEntry[], limit: number): EntryPage {
  const entries = rows.slice(0, limit);
  const last = entries[entries.length - 1];
  return { entries, next: rows.length > limit && last ? { created: last.created, id: last.id } : null };
}

/** The keyset clause that resumes loadAllEntries' order after `after`, and its arguments. */
function afterCursor(after: EntryCursor | undefined): { sql: string; args: string[] } {
  return after
    ? { sql: ' AND (created > ? OR (created = ? AND id > ?))', args: [after.created, after.created, after.id] }
    : { sql: '', args: [] };
}

/** Where the page after `rows` starts: one row past `limit` was read only to say that another page follows. */
function cursorAfter(rows: ReadonlyArray<{ created: string; id: string }>, limit: number): EntryCursor | null {
  const last = rows[Math.min(rows.length, limit) - 1];
  return rows.length > limit && last ? { created: last.created, id: last.id } : null;
}

/** A page of rows in loadAllEntries' order, with only the columns that say whether another store already holds each. */
export function loadEntryTextKeysPageAt(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  page: { readonly limit: number; readonly after?: EntryCursor },
): EntryTextKeyPage {
  const tenant = tenantAnd(tenantId);
  const after = afterCursor(page.after);
  // SAFETY: rows' shape matches the five columns named in the SELECT.
  const rows = cachedStatement(
    db,
    `SELECT id, tenant_id, content, source, created FROM memories ` +
      `WHERE 1${tenant.sql}${after.sql} ORDER BY created ASC, id ASC LIMIT ?`,
  ).all(...tenant.args, ...after.args, page.limit + 1) as Array<{
    id: string;
    tenant_id: string | null;
    content: string;
    source: string;
    created: string;
  }>;
  const keys = rows.slice(0, page.limit).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id ?? DEFAULT_TENANT_ID,
    content: row.content,
    source: row.source,
  }));
  return { keys, next: cursorAfter(rows, page.limit) };
}

/** Every tenant's rows in loadAllEntries' order through one cursor, so the caller holds one row at a time. */
export function* iterateEveryTenantEntriesAt(db: DatabaseSyncLike): Generator<MemoryEntry> {
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY created ASC, id ASC`)
    .iterate() as Iterable<MemoryRow>;
  for (const row of rows) yield rowToEntry(row);
}

function selectAllRows(db: DatabaseSyncLike, tenantId: string): MemoryRow[] {
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  return db
    .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ORDER BY created ASC, id ASC`)
    .all(tenantId) as MemoryRow[];
}

/** Up to `limit` rows in loadAllEntries' order, starting after `after`. */
export function loadEntriesPageAt(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  page: { limit: number; after?: EntryCursor },
): EntryPage {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (tenantId !== ALL_TENANTS) {
    where.push('tenant_id = ?');
    params.push(tenantId);
  }
  if (page.after) {
    where.push('(created > ? OR (created = ? AND id > ?))');
    params.push(page.after.created, page.after.created, page.after.id);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')} ` : '';
  // One extra row says whether another page follows without a count.
  params.push(page.limit + 1);
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ${clause}ORDER BY created ASC, id ASC LIMIT ?`,
  ).all(...params) as MemoryRow[];
  return pageOf(rows.map(rowToEntry), page.limit);
}

/** The columns a text match needs, for one row of a tenant. */
export interface TenantText {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly scope: string | null;
}

/** One page of TenantText rows, and where the next page starts (null after the last). */
export interface TenantTextPage {
  readonly texts: TenantText[];
  readonly next: EntryCursor | null;
}

/** A page of a tenant's rows in loadAllEntries' order with the columns a text match needs: callers read whole rows
 * only for the ids that match. */
export function selectTenantTextsPage(
  db: DatabaseSyncLike,
  tenantId: string,
  page: { readonly limit: number; readonly after?: EntryCursor },
): TenantTextPage {
  const after = afterCursor(page.after);
  // SAFETY: rows' shape matches the five columns named in the SELECT.
  const rows = cachedStatement(
    db,
    `SELECT id, content, source, scope, created FROM memories ` +
      `WHERE tenant_id = ?${after.sql} ORDER BY created ASC, id ASC LIMIT ?`,
  ).all(tenantId, ...after.args, page.limit + 1) as Array<TenantText & { created: string }>;
  return { texts: rows.slice(0, page.limit), next: cursorAfter(rows, page.limit) };
}

/** A page of the live rows whose source starts with `prefix`, in loadAllEntries' order, on the caller's handle; LIKE
 * folds case, so the prefix is checked again exactly and a page may hold fewer than `limit`. */
export function selectLiveEntriesBySourcePrefix(
  db: DatabaseSyncLike,
  tenantId: string,
  prefix: string,
  page: { readonly limit: number; readonly after?: EntryCursor },
): EntryPage {
  const after = afterCursor(page.after);
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ` +
      `AND superseded_by IS NULL AND source LIKE ? ESCAPE '\\'${after.sql} ORDER BY created ASC, id ASC LIMIT ?`,
  ).all(tenantId, `${escapeLike(prefix)}%`, ...after.args, page.limit + 1) as MemoryRow[];
  const { entries, next } = pageOf(rows.map(rowToEntry), page.limit);
  return { entries: entries.filter((entry) => entry.source.startsWith(prefix)), next };
}

/** A page of a tenant's rows tagged `rows.origin`, in loadAllEntries' order, narrowed as `rows` asks. */
export function selectEntriesFromOriginAt(
  db: DatabaseSyncLike,
  tenantId: string,
  rows: OriginRows,
  page: { readonly limit: number; readonly after?: EntryCursor },
): EntryPage {
  const live = rows.live ? ` AND COALESCE(superseded_by, '') = ''` : '';
  const { sourcePrefix } = rows;
  const prefix = sourcePrefix === undefined ? '' : ' AND substr(source, 1, ?) = ?';
  const prefixArgs = sourcePrefix === undefined ? [] : [sourcePrefix.length, sourcePrefix];
  const after = afterCursor(page.after);
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const found = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ` +
      `WHERE tenant_id = ? AND origin_project = ?${live}${prefix}${after.sql} ORDER BY created ASC, id ASC LIMIT ?`,
  ).all(tenantId, rows.origin, ...prefixArgs, ...after.args, page.limit + 1) as MemoryRow[];
  return pageOf(found.map(rowToEntry), page.limit);
}

/** Each project name's live rows in one grouped read, in the order its first row comes in loadAllEntries' order. */
export function selectOriginTalliesAt(db: DatabaseSyncLike, tenantId: string, sourcePrefix: string): OriginTally[] {
  // The unit separator sorts below every character of a time or an id, so the joined string orders as (created, id).
  // SAFETY: rows' shape matches the four columns named in the SELECT.
  return cachedStatement(
    db,
    `SELECT origin_project AS origin, COUNT(*) AS live, SUM(substr(source, 1, ?) = ?) AS prefixed, ` +
      `MAX(created) AS newest FROM memories WHERE tenant_id = ? AND COALESCE(superseded_by, '') = '' ` +
      `GROUP BY origin_project ORDER BY MIN(created || char(31) || id)`,
  ).all(sourcePrefix.length, sourcePrefix, tenantId) as OriginTally[];
}

// Letters and digits in every Unicode table unicode61 has shipped (Latin, Greek, Cyrillic, Hebrew, Arabic, Devanagari,
// Thai, kana, CJK, Hangul), so a phrase holding one names at least one token.
const SURE_TOKEN_CHAR = new RegExp('[0-9A-Za-zÀ-ÖØ-öø-ſΑ-ΡΣ-Ωα-ωА-я' + 'א-תء-غف-يअ-हก-ะ' + 'ぁ-んァ-ヶ一-龥가-힣]');
const PHRASE_WORDS = 32;
const IN_PHRASE_HITS = 'id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?)';

/** The index query for `text`'s first words, which a row holding the text word for word holds in a row; null when the
 * phrase might name no token, since an empty phrase matches no row. */
function holdingPhrase(text: string): string | null {
  const opening = duplicateKey(text).split(' ').slice(0, PHRASE_WORDS).join(' ');
  return SURE_TOKEN_CHAR.test(opening) ? `content : "${opening.replaceAll('"', '""')}"` : null;
}

function textKeyCandidates(db: DatabaseSyncLike, tenantId: TenantId, text: string, indexed: boolean): EntryTextKey[] {
  const phrase = indexed ? holdingPhrase(text) : null;
  const tenant = tenantAnd(tenantId, phrase === null ? 'tenant_id = ?' : TENANT_IS);
  const where = phrase === null ? 'instr(content, ?) > 0' : IN_PHRASE_HITS;
  // SAFETY: rows' shape matches the four columns named in the SELECT.
  const rows = cachedStatement(
    db,
    `SELECT id, tenant_id, content, source FROM memories WHERE ${where}${tenant.sql}`,
  ).all(phrase ?? longestWord(text), ...tenant.args) as Array<
    Omit<EntryTextKey, 'tenantId'> & { tenant_id: string | null }
  >;
  return rows.map(({ tenant_id, ...row }) => ({ ...row, tenantId: tenant_id ?? DEFAULT_TENANT_ID }));
}

/** The rows of `tenantId` that may hold one of `texts` word for word, spacing aside: the index's phrase hits, else the
 * rows holding the text's longest word. Callers check each again. */
export function selectTextKeysHoldingAt(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  texts: readonly string[],
): EntryTextKey[] {
  const indexed = isFtsAvailable(db) && isFtsInSync(db);
  const byId = new Map<string, EntryTextKey>();
  for (const text of new Set(texts)) {
    for (const key of textKeyCandidates(db, tenantId, text, indexed)) byId.set(key.id, key);
  }
  return [...byId.values()];
}

/** The ids among `ids` that a row of any tenant holds, one query per chunk. */
export function selectTakenIdsAt(db: DatabaseSyncLike, ids: readonly string[]): string[] {
  const taken: string[] = [];
  for (const chunk of chunked([...new Set(ids)])) {
    // SAFETY: rows' shape matches the one column named in the SELECT.
    const rows = cachedStatement(db, `SELECT id FROM memories WHERE id IN (${placeholders(chunk.length)})`).all(
      ...chunk,
    ) as Array<{ id: string }>;
    for (const row of rows) taken.push(row.id);
  }
  return taken;
}

// Content of every team-visible tenant row tagged `tag`, without reading the rest of the store; `origins` keeps one
// project's rows and user-global ones.
// No owner: a personal or connector-private row must never answer `duplicate` for, or stop, a team copy. `instr`
// prefilters; `includes` re-checks.
export function contentsWithTagAt(
  db: DatabaseSyncLike,
  tenantId: string,
  tag: string,
  origins?: readonly string[],
): string[] {
  const inProject = origins === undefined ? '' : ` AND (origin_project = '' OR ${originInSql(origins)})`;
  const admit = scopeAdmitSql('');
  /** SAFETY: rows' shape matches the two columns named in the SELECT below. */
  const rows = db
    .prepare(
      `SELECT content, tags_json FROM memories WHERE tenant_id = ? ` +
        `AND instr(tags_json, ?) > 0${inProject} AND ${admit.sql}`,
    )
    .all(tenantId, JSON.stringify(tag), ...(origins ?? []), ...admit.params) as Array<{
    content: string;
    tags_json: string;
  }>;
  return rows.filter((r) => parseJsonArray(r.tags_json).includes(tag)).map((r) => r.content);
}

/** A tenant's raw rows whose artifact_ref starts with `refPrefix`, by created then id. */
export function rawRowsUnderRefAt(db: DatabaseSyncLike, tenantId: string, refPrefix: string): RawRefRow[] {
  // SAFETY: query selects exactly the columns of RawRefRow, in the same
  // names, from the memories table this module owns.
  const rows = db
    .prepare(
      `SELECT id, artifact_ref, tags_json, scope FROM memories
         WHERE artifact_ref LIKE ? ESCAPE '\\' AND tenant_id = ? AND kind = 'raw' ORDER BY created ASC, id ASC`,
    )
    .all(`${escapeLike(refPrefix)}%`, tenantId) as RawRefRow[];
  // LIKE folds ASCII case, so the exact prefix is checked here.
  return rows.filter((r) => r.artifact_ref.startsWith(refPrefix));
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

/** A page of memories, by rowid, from a store whose schema may predate some columns; `columns` is the table's real
 * column set, and every schema has a rowid. */
export function selectPreviewRowsPage(
  db: DatabaseSyncLike,
  columns: ReadonlySet<string>,
  tenantId: string,
  page: { readonly limit: number; readonly afterRowid: number },
): Array<PreviewRow & { row_id: number }> {
  const tenant = columns.has('tenant_id') ? ' AND tenant_id = ?' : '';
  const column = (name: string, fallback: string): string => (columns.has(name) ? name : `${fallback} AS ${name}`);
  const statement = cachedStatement(
    db,
    `SELECT rowid AS row_id, id, content, ${column('source', "''")}, ` +
      `${column('confidence', 'NULL')}, ${column('extracted_from', 'NULL')}, ` +
      `${column('dag_level', '0')}, ${column('tags_json', "'[]'")} FROM memories ` +
      `WHERE rowid > ?${tenant} ORDER BY rowid LIMIT ?`,
  );
  const args = tenant ? [page.afterRowid, tenantId, page.limit] : [page.afterRowid, page.limit];
  // SAFETY: the SELECT names the rowid and every PreviewRow field, each a literal fallback when its column is missing.
  return statement.all(...args) as Array<PreviewRow & { row_id: number }>;
}

/** True when a memory row, of any tenant, already holds `id`. */
export function entryIdTakenAt(db: DatabaseSyncLike, id: string): boolean {
  return db.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(id) !== undefined;
}

/** The text, tenant and scope of memory `id`, or undefined when no row holds it. */
export function entryRejectRowAt(
  db: DatabaseSyncLike,
  id: string,
): { content: string; tenant_id: string; scope: string | null } | undefined {
  // SAFETY: row's shape matches the three columns named in the SELECT.
  return db.prepare(`SELECT content, tenant_id, scope FROM memories WHERE id = ?`).get(id) as
    | { content: string; tenant_id: string; scope: string | null }
    | undefined;
}

/** Memory ids held by each typed-object table, with the status of the object that holds them. */
const OBJECT_TABLES = [
  'decisions',
  'incidents',
  'processes',
  'policies',
  'skills',
  'project_briefs',
  'customer_notes',
] as const;

export function objectMemoryRowsAt(db: DatabaseSyncLike): Array<{ memory_id: string; status: string }> {
  const out: Array<{ memory_id: string; status: string }> = [];
  for (const table of OBJECT_TABLES) {
    // SAFETY: SELECT of two TEXT columns, filtered to a non-null memory_id.
    out.push(
      ...(db.prepare(`SELECT memory_id, status FROM ${table} WHERE memory_id IS NOT NULL`).all() as {
        memory_id: string;
        status: string;
      }[]),
    );
  }
  return out;
}

/** Live rows of a tenant whose source does not start with `sourcePrefix` that may hold `text` word for word, spacing
 * aside: the index's phrase hits, else the rows holding its longest word. `origins` (global store only) limits them to
 * user-global rows and those projects. A superset: the caller checks each again. */
export function selectRowsHoldingOutsideSourcePrefixAt(
  db: DatabaseSyncLike,
  tenantId: string,
  text: string,
  sourcePrefix: string,
  origins: readonly string[] | null,
): Array<{ id: string; content: string; source: string }> {
  const phrase = isFtsAvailable(db) && isFtsInSync(db) ? holdingPhrase(text) : null;
  const where = phrase === null ? 'instr(content, ?) > 0 AND tenant_id = ?' : `${IN_PHRASE_HITS} AND ${TENANT_IS}`;
  const visible = origins !== null ? ` AND (origin_project = '' OR ${originInSql(origins)})` : '';
  // SAFETY: the SELECT names the three columns of the row type.
  return cachedStatement(
    db,
    `SELECT id, content, source FROM memories WHERE ${where} AND superseded_by IS NULL ` +
      `AND substr(source, 1, ?) != ?${visible}`,
  ).all(phrase ?? longestWord(text), tenantId, sourcePrefix.length, sourcePrefix, ...(origins ?? [])) as Array<{
    id: string;
    content: string;
    source: string;
  }>;
}

/** Content of a tenant's live rows written by `source` and tagged `tag` that no extraction produced,
 * in loadAllEntries' order and in every scope; `exceptSessionId` drops one session's own rows. */
export function liveContentsBySourceAndTagAt(
  db: DatabaseSyncLike,
  tenantId: string,
  source: string,
  tag: string,
  exceptSessionId: string,
): string[] {
  /** SAFETY: rows' shape matches the two columns named in the SELECT below. */
  const rows = db
    .prepare(
      `SELECT content, tags_json FROM memories
   WHERE tenant_id = ? AND source = ? AND instr(tags_json, ?) > 0
     AND COALESCE(extracted_from, '') = '' AND COALESCE(superseded_by, '') = ''
     AND (source_session_id IS NULL OR source_session_id != ?)
   ORDER BY created ASC, id ASC`,
    )
    .all(tenantId, source, JSON.stringify(tag), exceptSessionId) as Array<{ content: string; tags_json: string }>;
  return rows.filter((r) => parseJsonArray(r.tags_json).includes(tag)).map((r) => r.content);
}

/** Every tenant's distilled rows nothing has superseded, in
 * loadAllEntries' order: the rows that can be each other's duplicate. */
export function loadCurrentDistilledEntriesAt(db: DatabaseSyncLike): MemoryEntry[] {
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories
     WHERE COALESCE(kind, 'distilled') = 'distilled' AND COALESCE(superseded_by, '') = ''
     ORDER BY created ASC, id ASC`,
    )
    .all() as MemoryRow[];
  return rows.map(rowToEntry);
}

/** A page of the rows holding at least one signal, in loadAllEntries' order. A superset: callers re-check each row. */
export function loadEntriesWithSignalsAt(
  db: DatabaseSyncLike,
  signals: EntrySignals,
  tenantId: TenantId,
  page: { readonly limit: number; readonly after?: EntryCursor },
): EntryPage {
  // A backslash may hide an escaped tag from instr, so such rows always pass; LIKE folds case, so the prefix match is
  // wider than startsWith.
  const anyOf = [
    'pinned != 0',
    'retrieval_count >= ?',
    `emotional_valence IN (${placeholders(signals.valences.length)})`,
    "source LIKE ? ESCAPE '\\'",
    "instr(tags_json, '\\') > 0",
    ...signals.tags.map(() => 'instr(tags_json, ?) > 0'),
  ];
  const params = [
    signals.minRetrievals,
    ...signals.valences,
    `${escapeLike(signals.sourcePrefix)}%`,
    ...signals.tags.map((t) => JSON.stringify(t)),
  ];
  const tenant = tenantAnd(tenantId);
  const after = afterCursor(page.after);
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ` +
      `WHERE (${anyOf.join(' OR ')})${tenant.sql}${after.sql} ORDER BY created ASC, id ASC LIMIT ?`,
  ).all(...params, ...tenant.args, ...after.args, page.limit + 1) as MemoryRow[];
  return pageOf(rows.map(rowToEntry), page.limit);
}

/** A tenant's rows from `origins` that nothing superseded and
 * that are neither raw nor archived, in loadAllEntries' order. */
export function loadCurrentEntriesFromOriginsAt(
  db: DatabaseSyncLike,
  tenantId: string,
  origins: readonly string[],
): MemoryEntry[] {
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories
   WHERE tenant_id = ? AND ${originInSql(origins)} AND COALESCE(superseded_by, '') = ''
     AND COALESCE(kind, 'distilled') NOT IN ('raw', 'archived')
   ORDER BY created ASC, id ASC`,
    )
    .all(tenantId, ...origins) as MemoryRow[];
  return rows.map(rowToEntry);
}
