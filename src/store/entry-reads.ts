import type { MemoryEntry } from '../memory.js';
import { closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry, parseJsonArray } from './rows.js';
import { openStore } from './open.js';

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

/**
 * Batched lookup. Caps at 500 ids per call to keep the IN(?,?,...) clause
 * within SQLite limits. Tenant filter is enforced when `tenantId` is passed.
 * Used by DAG-aware recall (docs/plans/2026-05-05-dag-recall.md Task 1.5)
 * to fetch parent summaries for a set of overflowed leaves.
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
    // T2: no ORDER BY meant row order followed SQLite's IN(...) scan order
    // (undefined w.r.t. the caller's `ids` order). created ASC, id ASC
    // makes it deterministic.
    // SAFETY: both branches select exactly MEMORY_SELECT_COLUMNS, matching
    // MemoryRow's field set.
    const rows = tenantId !== undefined
      ? db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders}) AND tenant_id = ? ORDER BY created ASC, content ASC, id ASC`,
        ).all(...capped, tenantId) as MemoryRow[]
      : db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders}) ORDER BY created ASC, content ASC, id ASC`,
        ).all(...capped) as MemoryRow[];
    return rows.map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * All `kind='raw'` rows for a given session, tenant-scoped, returned
 * oldest-first. Used by `api.assemble` to walk a session's chronological
 * context. Excludes superseded rows.
 *
 * Cap semantics (v1.6.2 codex fix): when `cap` is provided, the NEWEST
 * `cap` rows are loaded — `ORDER BY created DESC LIMIT cap` server-side,
 * reversed to oldest-first client-side. Pre-v1.6.2 ordered ASC + LIMIT,
 * which silently dropped the newest rows and broke fresh-tail in assemble.
 *
 * Returns `[]` for an empty sessionId. Final order: `created ASC, id ASC`.
 */
export function loadSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId?: string,
  cap?: number,
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
 * v1.6.3 codex P1 / senior P0: an earlier draft of this helper ran an
 * unscoped COUNT, which let a no-scope caller infer the existence of
 * private rows by comparing `totalRaw` against `items.length`. This
 * version SQL-encodes the same default-deny rule `passesScopeFilterForRecall`
 * applies in TS:
 *   - explicit scope passed: exact-match
 *   - no scope: rows where scope IS NULL, or scope is NOT a `<source>:private:*`
 *     pattern AND not the `unknown:legacy` quarantine bucket.
 *
 * `tenantId` is optional for back-compat. Pass `undefined` only when
 * intentionally counting cross-tenant; `assemble()` passes `ctx.tenantId`.
 */
export function countSessionRawMemories(
  hippoRoot: string,
  sessionId: string,
  tenantId?: string,
  scope?: string,
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
    if (scope !== undefined && scope !== '') {
      sql += ' AND scope = ?';
      params.push(scope);
    } else {
      // SQL-ify the TS default-deny: scope IS NULL OR (NOT LIKE '%:private:%'
      // AND != 'unknown:legacy'). Mirrors api.passesScopeFilterForRecall.
      sql += ` AND (scope IS NULL OR (scope NOT LIKE '%:private:%' AND scope != 'unknown:legacy'))`;
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
 * v1.6.2 codex review fix: pre-v1.6.2 was tenant-wide only. With multiple
 * concurrent sessions in a tenant, fresh-tail recall surfaced unrelated
 * rows from other sessions and stamped them `isFreshTail=true`. Callers
 * that want session-scoped fresh-tail now pass `sessionId`. The
 * tenant-wide form (no sessionId) still exists for "anything new across
 * the whole tenant" — pass undefined to opt in.
 *
 * Bounded count cap at 200 — beyond that the caller should filter via
 * tags/scope rather than time-windowed recall.
 *
 * Deprecation note (v1.6.5) — the **tenant-wide call shape** (omitting
 * `sessionId`) is rarely the right shape for "what did I just see in this
 * conversation". `api.recall` enforces session scoping when
 * `HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1` is set, throwing
 * `RecallContractError` instead. Tenant-wide remains the back-compat default
 * but is discouraged for new callers. Passing `sessionId` is fully supported
 * and recommended; this function is NOT deprecated as a whole.
 */
export function loadFreshRawMemories(
  hippoRoot: string,
  count: number,
  tenantId?: string,
  sessionId?: string,
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
    // T2: tie tail keeps the LIMIT window keyed on `created` while making
    // same-`created` rows deterministic. `content` before `id` (codex
    // review): ids are random UUIDs, so an id-only tail would pick WHICH
    // same-created rows make the window per-instance; content is
    // cross-ingest-stable.
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
 * Direct DAG children of a parent summary. Tenant scoped. Returns only rows
 * whose `dag_parent_id` matches `parentId`; does NOT walk recursively.
 * Used by `drillDown` (Task 3).
 */
export function loadChildrenOf(
  hippoRoot: string,
  parentId: string,
  tenantId?: string,
): MemoryEntry[] {
  const db = openStore(hippoRoot);
  try {
    // SAFETY: both branches select exactly MEMORY_SELECT_COLUMNS, matching
    // MemoryRow's field set.
    const rows = tenantId !== undefined
      ? db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE dag_parent_id = ? AND tenant_id = ? ORDER BY created ASC, id ASC`,
        ).all(parentId, tenantId) as MemoryRow[]
      : db.prepare(
          `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE dag_parent_id = ? ORDER BY created ASC, id ASC`,
        ).all(parentId) as MemoryRow[];
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
  ).all(tenantId, `${prefix.replace(/[%_\\]/g, '\\$&')}%`) as MemoryRow[];
  return rows.map(rowToEntry).filter((entry) => entry.source.startsWith(prefix));
}

// Content of every tenant row tagged `tag`, without reading the rest of the store.
// `instr` is a substring prefilter over the raw JSON; `includes` below re-checks exactly.
export function loadContentsWithTag(hippoRoot: string, tenantId: string, tag: string): string[] {
  const db = openStore(hippoRoot);
  try {
    /** SAFETY: rows' shape matches the two columns named in the SELECT below. */
    const rows = db.prepare(
      `SELECT content, tags_json FROM memories WHERE tenant_id = ? AND instr(tags_json, ?) > 0`,
    ).all(tenantId, JSON.stringify(tag)) as Array<{ content: string; tags_json: string }>;
    return rows.filter((r) => parseJsonArray(r.tags_json).includes(tag)).map((r) => r.content);
  } finally {
    closeHippoDb(db);
  }
}
