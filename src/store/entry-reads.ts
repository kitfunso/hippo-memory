import type { MemoryEntry } from '../core/memory.js';
import { isFtsAvailable, isFtsInSync, type DatabaseSyncLike } from '../db/index.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry, parseJsonArray } from './rows.js';
import { onHandle, openStore } from './open.js';
import { cachedStatement } from './statement-cache.js';
import { escapeLike } from '../util/escape.js';
import { originInSql } from '../core/project-identity.js';
import { scopeAdmitSql } from './rule-sql.js';
import { chunked } from '../util/chunked.js';
import { DEFAULT_TENANT_ID } from '../util/env.js';
import { placeholders } from '../util/sql.js';
import type { EntryCursor, EntryPage } from './port/consolidation.js';
import type { RawRefRow } from './port/context-reads.js';
import type { EntrySignals, EntryTextKeyPage } from './port/sharing.js';

const MAX_IDS_PER_READ = 500;
const MAX_FRESH_RAW = 200;

// The plus keeps SQLite on the primary key for an id list: with
// a bare tenant_id it walks every row of the tenant instead.
export const TENANT_IS = '+tenant_id = ?';

/** The ` AND <condition>` suffix and its argument when a read is tenant-scoped; both empty when it spans tenants. */
function tenantAnd(tenantId: string | undefined, condition: string = 'tenant_id = ?'): { sql: string; args: string[] } {
  return tenantId === undefined ? { sql: '', args: [] } : { sql: ` AND ${condition}`, args: [tenantId] };
}

/** Read a memory entry by ID. With `tenantId` the read is tenant-scoped (cross-tenant returns null); omitted, no
 * tenant filter is applied. */
export function readEntryAt(db: DatabaseSyncLike, id: string, tenantId?: string): MemoryEntry | null {
  // SAFETY: both branches select exactly MEMORY_SELECT_COLUMNS, matching
  // MemoryRow's field set.
  const row =
    tenantId !== undefined
      ? (db
          .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ? AND tenant_id = ?`)
          .get(id, tenantId) as MemoryRow | undefined)
      : (db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined);
  return row ? rowToEntry(row) : null;
}

export function readEntry(hippoRoot: string, id: string, tenantId?: string): MemoryEntry | null {
  return onHandle(hippoRoot, (db) => readEntryAt(db, id, tenantId), openStore);
}

/** Rows by id on the caller's handle, one query per chunk; an
 * id missing or in another tenant is absent from the map. */
export function selectEntriesByIds(
  db: DatabaseSyncLike,
  ids: readonly string[],
  tenantId?: string,
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
  tenantId?: string,
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
      const parentId = entry.dag_parent_id ?? '';
      const bucket = byParent.get(parentId);
      if (bucket) bucket.push(entry);
      else byParent.set(parentId, [entry]);
    }
  }
  return byParent;
}

/** Batched lookup, capped at 500 ids per call to keep IN(?,?,...) within SQLite limits; tenant filter enforced when
 * `tenantId` is passed. */
export function loadEntriesByIdsAt(db: DatabaseSyncLike, ids: readonly string[], tenantId?: string): MemoryEntry[] {
  if (ids.length === 0) return [];
  const capped = ids.slice(0, MAX_IDS_PER_READ);
  const marks = placeholders(capped.length);
  // Without ORDER BY, rows follow SQLite's IN(...) scan order, undefined w.r.t. `ids`.
  // SAFETY: both branches select exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows =
    tenantId !== undefined
      ? (db
          .prepare(
            `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${marks}) ` +
              `AND ${TENANT_IS} ORDER BY created ASC, content ASC, id ASC`,
          )
          .all(...capped, tenantId) as MemoryRow[])
      : (db
          .prepare(
            `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ` +
              `WHERE id IN (${marks}) ORDER BY created ASC, content ASC, id ASC`,
          )
          .all(...capped) as MemoryRow[]);
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
  tenantId?: string,
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
 * `passesScopeFilterForRecall`'s default-deny: explicit scope matches exactly, none admits only `ownScope`.
 * `tenantId` undefined counts cross-tenant. */
export function countSessionRawMemoriesAt(
  db: DatabaseSyncLike,
  sessionId: string,
  tenantId?: string,
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
  tenantId?: string,
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
  return selectAllEntries(db, tenantId);
}

export function loadAllEntries(hippoRoot: string, tenantId: string): MemoryEntry[] {
  return onHandle(hippoRoot, (db) => loadAllEntriesAt(db, tenantId), openStore);
}

/** Every tenant's entries, for host-wide work such as consolidation; never for a request that answers a tenant. */
export function loadEveryTenantEntriesAt(db: DatabaseSyncLike): MemoryEntry[] {
  return selectAllEntries(db);
}

/** Every tenant's memory ids in loadAllEntries' order, for a caller that reads the rows a page at a time instead of
 * holding them all. */
export function loadAllEntryIdsAt(db: DatabaseSyncLike): string[] {
  // SAFETY: the SELECT names exactly the one column read.
  return (db.prepare('SELECT id FROM memories ORDER BY created ASC, id ASC').all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
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
  tenantId: string | undefined,
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

/** A page of rows in loadAllEntries' order (every tenant unless one is named), with only the columns that say whether
 * another store already holds each. */
export function loadEntryTextKeysPageAt(
  db: DatabaseSyncLike,
  tenantId: string | undefined,
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
    tenant_id: row.tenant_id ?? DEFAULT_TENANT_ID,
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

function selectAllRows(db: DatabaseSyncLike, tenantId?: string): MemoryRow[] {
  // SAFETY: both branches select exactly MEMORY_SELECT_COLUMNS, matching
  // MemoryRow's field set.
  return tenantId !== undefined
    ? (db
        .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ORDER BY created ASC, id ASC`)
        .all(tenantId) as MemoryRow[])
    : (db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY created ASC, id ASC`).all() as MemoryRow[]);
}

/** Up to `limit` rows in loadAllEntries' order, starting after `after`; omitting `tenantId` reads every tenant. */
export function loadEntriesPageAt(
  db: DatabaseSyncLike,
  tenantId: string | undefined,
  page: { limit: number; after?: EntryCursor },
): EntryPage {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (tenantId !== undefined) {
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

/** Every memory row on an open connection, so a caller can read inside its own transaction. */
export function selectAllEntries(db: DatabaseSyncLike, tenantId?: string): MemoryEntry[] {
  return selectAllRows(db, tenantId).map(rowToEntry);
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

/** Live rows whose source starts with `prefix`, on the caller's
 * handle; LIKE folds case, so the prefix is checked again exactly. */
export function selectLiveEntriesBySourcePrefix(db: DatabaseSyncLike, tenantId: string, prefix: string): MemoryEntry[] {
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ` +
        `AND superseded_by IS NULL AND source LIKE ? ESCAPE '\\'`,
    )
    .all(tenantId, `${escapeLike(prefix)}%`) as MemoryRow[];
  return rows.map(rowToEntry).filter((entry) => entry.source.startsWith(prefix));
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

/** Live rows of a tenant whose source does not start with `sourcePrefix`; `origins` (global store only) limits them
 * to user-global rows and those projects. */
export function selectRowsOutsideSourcePrefixAt(
  db: DatabaseSyncLike,
  tenantId: string,
  sourcePrefix: string,
  origins: readonly string[] | null,
): Array<{ id: string; content: string; source: string }> {
  const visible = origins !== null ? ` AND (origin_project = '' OR ${originInSql(origins)})` : '';
  const params = origins !== null ? [tenantId, sourcePrefix, ...origins] : [tenantId, sourcePrefix];
  // SAFETY: the SELECT names the three columns of the row type.
  return db
    .prepare(
      `SELECT id, content, source FROM memories
      WHERE tenant_id = ? AND superseded_by IS NULL AND substr(source, 1, ${sourcePrefix.length}) != ?${visible}`,
    )
    .all(...params) as Array<{ id: string; content: string; source: string }>;
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

/** A page of the rows holding at least one signal, in loadAllEntries' order; an undefined `tenantId` reads every
 * tenant. A superset: callers re-check each row. */
export function loadEntriesWithSignalsAt(
  db: DatabaseSyncLike,
  signals: EntrySignals,
  tenantId: string | undefined,
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
