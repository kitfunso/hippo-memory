import type { MemoryEntry } from '../memory.js';
import { closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry, parseJsonArray } from './rows.js';
import { openStore } from './open.js';
import { escapeLike } from '../escape.js';
import { originInSql } from '../project-identity.js';
import { scopeAdmitSql } from '../recall-scope.js';

// The plus keeps SQLite on the primary key for an id list: with a bare tenant_id it walks every row of the tenant instead.
export const TENANT_IS = '+tenant_id = ?';

/**
 * Read a memory entry by ID.
 *
 * When `tenantId` is provided, the read is scoped to that tenant (cross-tenant
 * lookups return null). When omitted, no tenant filter is applied — preserves
 * legacy single-tenant callers and the writeEntry/readEntry round-trip.
 */
export function readEntry(hippoRoot: string, id: string, tenantId?: string): MemoryEntry | null {
  const db = openStore(hippoRoot);
  try {
    // SAFETY: both branches select exactly MEMORY_SELECT_COLUMNS, matching
    // MemoryRow's field set.
    const row = tenantId !== undefined
      ? db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ? AND tenant_id = ?`,
        ).get(id, tenantId) as MemoryRow | undefined
      : db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = ?`,
        ).get(id) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

/** Ids per `IN (...)` list: far under SQLite's bound-parameter limit, with room for the tenant filter. */
export const ID_CHUNK = 500;

/** `items` in consecutive slices of at most `size`. */
export function chunked<T>(items: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Answers whether a tenant's rows in this store hold an id: `ids` are looked up now, one query per chunk, and any other id on its first ask. */
export function heldIdLookup(hippoRoot: string, tenantId: string, ids: readonly string[]): (id: string) => boolean {
  const held = new Map<string, boolean>();
  const lookUp = (asked: readonly string[]): void => {
    const db = openStore(hippoRoot);
    try {
      for (const chunk of chunked([...new Set(asked)])) {
        for (const id of chunk) held.set(id, false);
        // SAFETY: rows' shape matches the single `id` column selected.
        const rows = db.prepare(
          `SELECT id FROM memories WHERE id IN (${chunk.map(() => '?').join(',')}) AND ${TENANT_IS}`,
        ).all(...chunk, tenantId) as Array<{ id: string }>;
        for (const row of rows) held.set(row.id, true);
      }
    } finally {
      closeHippoDb(db);
    }
  };
  if (ids.length > 0) lookUp(ids);
  return (id) => {
    if (!held.has(id)) lookUp([id]);
    return held.get(id) === true;
  };
}

/** Rows by id on the caller's handle, one query per chunk; an id missing or in another tenant is absent from the map. */
export function selectEntriesByIds(
  db: DatabaseSyncLike,
  ids: readonly string[],
  tenantId?: string,
): Map<string, MemoryEntry> {
  const byId = new Map<string, MemoryEntry>();
  const tenantClause = tenantId !== undefined ? ` AND ${TENANT_IS}` : '';
  const tenantArgs = tenantId !== undefined ? [tenantId] : [];
  for (const chunk of chunked([...new Set(ids)])) {
    const placeholders = chunk.map(() => '?').join(',');
    // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const rows = db.prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders})${tenantClause}`,
    ).all(...chunk, ...tenantArgs) as MemoryRow[];
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
  const tenantClause = tenantId !== undefined ? ` AND ${TENANT_IS}` : '';
  const tenantArgs = tenantId !== undefined ? [tenantId] : [];
  for (const chunk of chunked([...new Set(parentIds)])) {
    const placeholders = chunk.map(() => '?').join(',');
    // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const rows = db.prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE dag_parent_id IN (${placeholders})${tenantClause} ORDER BY created ASC, id ASC`,
    ).all(...chunk, ...tenantArgs) as MemoryRow[];
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

/**
 * Batched lookup. Caps at 500 ids per call to keep the IN(?,?,...) clause
 * within SQLite limits. Tenant filter is enforced when `tenantId` is passed.
 * Used by DAG-aware recall to fetch parent summaries for a set of overflowed leaves.
 */
export function loadEntriesByIds(
  hippoRoot: string,
  ids: readonly string[],
  tenantId?: string,
): MemoryEntry[] {
  if (ids.length === 0) return [];
  const capped = ids.slice(0, 500);
  const db = openStore(hippoRoot);
  try {
    const placeholders = capped.map(() => '?').join(',');
    // Without ORDER BY, rows follow SQLite's IN(...) scan order, which is undefined w.r.t. `ids`.
    // SAFETY: both branches select exactly MEMORY_SELECT_COLUMNS, matching
    // MemoryRow's field set.
    const rows = tenantId !== undefined
      ? db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders}) AND ${TENANT_IS} ORDER BY created ASC, content ASC, id ASC`,
        ).all(...capped, tenantId) as MemoryRow[]
      : db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders}) ORDER BY created ASC, content ASC, id ASC`,
        ).all(...capped) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

function originClause(origins: readonly string[] | undefined): string {
  return origins === undefined ? '' : ` AND (origin_project = '' OR ${originInSql(origins)})`;
}

/**
 * All `kind='raw'` rows for a given session, tenant-scoped, returned
 * oldest-first. Used by `api.assemble` to walk a session's chronological
 * context. Excludes superseded rows.
 *
 * Cap semantics: when `cap` is provided, the NEWEST `cap` rows are loaded (DESC LIMIT server-side,
 * reversed client-side); ASC + LIMIT would drop the newest rows and break fresh-tail in assemble.
 *
 * Returns `[]` for an empty sessionId. Final order: `created ASC, id ASC`.
 */
export function loadSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId?: string,
  cap?: number,
  origins?: readonly string[],
): MemoryEntry[] {
  if (!sessionId) return [];
  const db = openStore(hippoRoot);
  try {
    const params: Array<string | number> = [];
    let sql = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' AND source_session_id = ? AND superseded_by IS NULL`;
    params.push(sessionId);
    if (tenantId !== undefined) {
      sql += ' AND tenant_id = ?';
      params.push(tenantId);
    }
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
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Pre-cap, scope-aware row count for a session. Lets `assemble` report
 * the full session size even when `rowCap` truncates the loaded window,
 * WITHOUT leaking rows the caller wouldn't have been allowed to load.
 *
 * An unscoped COUNT would let a no-scope caller infer private rows by comparing `totalRaw`
 * against `items.length`, so this SQL-encodes the default-deny rule `passesScopeFilterForRecall` applies in TS:
 *   - explicit scope passed: exact-match
 *   - no scope: `scopeAdmitSql`'s default deny, which admits `ownScope`, the caller's personal scope.
 *
 * `tenantId` is optional for back-compat. Pass `undefined` only when
 * intentionally counting cross-tenant; `assemble()` passes `ctx.tenantId`.
 */
export function countSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId?: string,
  scope?: string,
  ownScope?: string,
  origins?: readonly string[],
): number {
  if (!sessionId) return 0;
  const db = openStore(hippoRoot);
  try {
    const params: Array<string> = [];
    let sql = `SELECT COUNT(*) AS c FROM memories WHERE kind = 'raw' AND source_session_id = ? AND superseded_by IS NULL`;
    params.push(sessionId);
    if (tenantId !== undefined) {
      sql += ' AND tenant_id = ?';
      params.push(tenantId);
    }
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
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Last N kind='raw' memories by `created` desc. Tenant scoped. When
 * `sessionId` is supplied, also constrains to a specific session — that
 * is the correct shape for "what did I just see in THIS session."
 *
 * Without `sessionId`, concurrent sessions in a tenant surface each other's rows as fresh tail;
 * pass undefined only for "anything new across the whole tenant".
 *
 * Bounded count cap at 200 — beyond that the caller should filter via
 * tags/scope rather than time-windowed recall.
 *
 * The tenant-wide shape is the back-compat default but discouraged; `api.recall` throws
 * `RecallContractError` for it when `HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1` is set.
 */
export function loadFreshRawMemories(
  hippoRoot: string,
  count: number,
  tenantId?: string,
  sessionId?: string,
  origins?: readonly string[],
): MemoryEntry[] {
  if (count <= 0) return [];
  const capped = Math.min(count, 200);
  const db = openStore(hippoRoot);
  try {
    const params: Array<string | number> = [];
    let sql = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' AND superseded_by IS NULL`;
    if (tenantId !== undefined) {
      sql += ' AND tenant_id = ?';
      params.push(tenantId);
    }
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
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Load all entries from SQLite.
 *
 * When `tenantId` is provided, results are scoped to that tenant. Omitting it
 * yields all rows (legacy behavior used by consolidate/autolearn etc.). Recall
 * paths that surface results to a user MUST pass a resolved tenant.
 */
export function loadAllEntries(hippoRoot: string, tenantId?: string): MemoryEntry[] {
  const db = openStore(hippoRoot);
  try {
    return selectAllEntries(db, tenantId);
  } finally {
    closeHippoDb(db);
  }
}

/** Every memory row on an open connection, so a caller can read inside its own transaction. */
export function selectAllEntries(db: DatabaseSyncLike, tenantId?: string): MemoryEntry[] {
  // SAFETY: both branches select exactly MEMORY_SELECT_COLUMNS, matching
  // MemoryRow's field set.
  const rows = tenantId !== undefined
    ? db.prepare(
        `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? ORDER BY created ASC, id ASC`,
      ).all(tenantId) as MemoryRow[]
    : db.prepare(
        `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories ORDER BY created ASC, id ASC`,
      ).all() as MemoryRow[];
  return rows.map(rowToEntry);
}

/** Live rows whose source starts with `prefix`, on the caller's handle; LIKE folds case, so the prefix is checked again exactly. */
export function selectLiveEntriesBySourcePrefix(db: DatabaseSyncLike, tenantId: string, prefix: string): MemoryEntry[] {
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db.prepare(
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE tenant_id = ? AND superseded_by IS NULL AND source LIKE ? ESCAPE '\\'`,
  ).all(tenantId, `${escapeLike(prefix)}%`) as MemoryRow[];
  return rows.map(rowToEntry).filter((entry) => entry.source.startsWith(prefix));
}

// Content of every team-visible tenant row tagged `tag`, without reading the rest of the store; `origins` keeps one project's rows and user-global ones.
// No owner: a personal or connector-private row must never answer `duplicate` for, or stop, a team copy. `instr` prefilters; `includes` re-checks.
export function loadContentsWithTag(hippoRoot: string, tenantId: string, tag: string, origins?: readonly string[]): string[] {
  const db = openStore(hippoRoot);
  try {
    const inProject = origins === undefined ? '' : ` AND (origin_project = '' OR ${originInSql(origins)})`;
    const admit = scopeAdmitSql('');
    /** SAFETY: rows' shape matches the two columns named in the SELECT below. */
    const rows = db.prepare(
      `SELECT content, tags_json FROM memories WHERE tenant_id = ? AND instr(tags_json, ?) > 0${inProject} AND ${admit.sql}`,
    ).all(tenantId, JSON.stringify(tag), ...(origins ?? []), ...admit.params) as Array<{ content: string; tags_json: string }>;
    return rows.filter((r) => parseJsonArray(r.tags_json).includes(tag)).map((r) => r.content);
  } finally {
    closeHippoDb(db);
  }
}

export interface VaultRawRow {
  id: string;
  artifact_ref: string;
  tags_json: string;
  scope: string | null;
}

/** Live raw rows whose artifact_ref matches a LIKE pattern, for one tenant; the store is set up first when it is new. */
export function loadVaultRawRows(hippoRoot: string, likeParam: string, tenantId: string): VaultRawRow[] {
  const db = openStore(hippoRoot);
  try {
    // SAFETY: query selects exactly the columns of VaultRawRow, in the same
    // names, from the memories table this module owns.
    return db
      .prepare(
        `SELECT id, artifact_ref, tags_json, scope FROM memories
           WHERE artifact_ref LIKE ? ESCAPE '\\' AND tenant_id = ? AND kind = 'raw'`,
      )
      .all(likeParam, tenantId) as VaultRawRow[];
  } finally {
    closeHippoDb(db);
  }
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

/** Reads memories from a store whose schema may predate some columns; `columns` is the table's real column set. */
export function selectPreviewRows(db: DatabaseSyncLike, columns: ReadonlySet<string>, tenantId: string): PreviewRow[] {
  const tenant = columns.has('tenant_id') ? ' WHERE tenant_id = ?' : '';
  const column = (name: string, fallback: string): string => (columns.has(name) ? name : `${fallback} AS ${name}`);
  const statement = db.prepare(`SELECT id, content, ${column('source', "''")}, ${column('confidence', 'NULL')}, ${column('extracted_from', 'NULL')}, ${column('dag_level', '0')}, ${column('tags_json', "'[]'")} FROM memories${tenant}`);
  // SAFETY: the SELECT names every PreviewRow field, each a literal fallback when its column is missing.
  return (tenant ? statement.all(tenantId) : statement.all()) as PreviewRow[];
}

/** True when a memory row, of any tenant, already holds `id`. */
export function entryIdTakenAt(db: DatabaseSyncLike, id: string): boolean {
  return db.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(id) !== undefined;
}

/** The text, tenant and scope of memory `id`, or undefined when no row holds it. */
export function entryRejectRowAt(db: DatabaseSyncLike, id: string): { content: string; tenant_id: string; scope: string | null } | undefined {
  // SAFETY: row's shape matches the three columns named in the SELECT.
  return db
    .prepare(`SELECT content, tenant_id, scope FROM memories WHERE id = ?`)
    .get(id) as { content: string; tenant_id: string; scope: string | null } | undefined;
}

/** Memory ids held by each typed-object table, with the status of the object that holds them. */
const OBJECT_TABLES = ['decisions', 'incidents', 'processes', 'policies', 'skills', 'project_briefs', 'customer_notes'] as const;

export function objectMemoryRowsAt(db: DatabaseSyncLike): Array<{ memory_id: string; status: string }> {
  const out: Array<{ memory_id: string; status: string }> = [];
  for (const table of OBJECT_TABLES) {
    // SAFETY: SELECT of two TEXT columns, filtered to a non-null memory_id.
    out.push(...(db.prepare(`SELECT memory_id, status FROM ${table} WHERE memory_id IS NOT NULL`).all() as { memory_id: string; status: string }[]));
  }
  return out;
}

/** Live rows of a tenant whose source does not start with `sourcePrefix`; `origins` (global store only) limits them to user-global rows and those projects. */
export function selectRowsOutsideSourcePrefixAt(
  db: DatabaseSyncLike, tenantId: string, sourcePrefix: string, origins: readonly string[] | null,
): Array<{ id: string; content: string; source: string }> {
  const visible = origins !== null ? ` AND (origin_project = '' OR ${originInSql(origins)})` : '';
  const params = origins !== null ? [tenantId, sourcePrefix, ...origins] : [tenantId, sourcePrefix];
  // SAFETY: the SELECT names the three columns of the row type.
  return db.prepare(
    `SELECT id, content, source FROM memories
      WHERE tenant_id = ? AND superseded_by IS NULL AND substr(source, 1, ${sourcePrefix.length}) != ?${visible}`,
  ).all(...params) as Array<{ id: string; content: string; source: string }>;
}

/** Content of a tenant's live rows written by `source` and tagged `tag` that no extraction produced, in loadAllEntries' order and in every scope; `exceptSessionId` drops one session's own rows. */
export function loadLiveContentsBySourceAndTag(hippoRoot: string, tenantId: string, source: string, tag: string, exceptSessionId: string): string[] {
  const db = openStore(hippoRoot);
  try {
    /** SAFETY: rows' shape matches the two columns named in the SELECT below. */
    const rows = db.prepare(
      `SELECT content, tags_json FROM memories
       WHERE tenant_id = ? AND source = ? AND instr(tags_json, ?) > 0
         AND COALESCE(extracted_from, '') = '' AND COALESCE(superseded_by, '') = ''
         AND (source_session_id IS NULL OR source_session_id != ?)
       ORDER BY created ASC, id ASC`,
    ).all(tenantId, source, JSON.stringify(tag), exceptSessionId) as Array<{ content: string; tags_json: string }>;
    return rows.filter((r) => parseJsonArray(r.tags_json).includes(tag)).map((r) => r.content);
  } finally {
    closeHippoDb(db);
  }
}

/** Every tenant's distilled rows nothing has superseded, in loadAllEntries' order: the rows that can be each other's duplicate. */
export function loadCurrentDistilledEntries(hippoRoot: string): MemoryEntry[] {
  const db = openStore(hippoRoot);
  try {
    // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const rows = db.prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories
       WHERE COALESCE(kind, 'distilled') = 'distilled' AND COALESCE(superseded_by, '') = ''
       ORDER BY created ASC, id ASC`,
    ).all() as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}
