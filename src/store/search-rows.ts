import type { MemoryEntry } from '../memory.js';
import { openHippoDb, isFtsAvailable, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { tokenize } from '../tokenize.js';
import { isPersonalScope, scopeAdmitSql, type SqlFragment } from '../recall-scope.js';
import { ftsTermParts, RAREST_TERM_COUNT, rarestFtsQuery } from '../prompt-recall.js';
import { log } from '../log.js';
import { originInSql } from '../project-identity.js';
import { topVectorMatches } from '../db/vector-store.js';
import {
  type MemoryRow,
  MEMORY_SELECT_COLUMNS,
  MEMORY_SEARCH_COLUMNS,
  DEFAULT_SEARCH_CANDIDATE_LIMIT,
  rowToEntry,
} from './rows.js';
import { openStore } from './open.js';
import { escapeLike } from '../escape.js';

/**
 * Recall-mode scope filter shape, exported so callers and tests can name it. Three modes:
 *   - 'default-deny': exclude scopes in `RECALL_DEFAULT_DENY_SCOPES`.
 *   - 'exact': exact match on `m.scope = value` (api.recall's explicit-scope request semantics).
 *   - 'default-deny-or-exact': the default-admitted set PLUS rows whose scope equals `value` (CLI `--scope`).
 *     The flag began as a tag-boost hint, so narrowing would return zero rows for tag-scoped workflows.
 *
 * Background pipelines (`consolidate`, `embeddings`, `refine-llm`, ...) call
 * `loadSearchEntries` (no scopeFilter arg) and see all rows including
 * quarantine.
 */
/** @internal Internal SQL-builder shape; not on the public API
 *  surface (not re-exported from `src/index.ts`). Subject to change. */
export type RecallScopeFilter =
  | { mode: 'default-deny'; ownScope?: string }
  | { mode: 'exact'; value: string }
  | { mode: 'default-deny-or-exact'; value: string; ownScope?: string };

/** The recall scope rule for a table column prefix (`m.` or none); `passesScopeFilterForRecall` in recall-scope.ts is its JS twin. */
function recallScopeClause(col: 'm.' | '', scopeFilter: RecallScopeFilter | undefined): SqlFragment {
  if (scopeFilter === undefined) return { sql: '', params: [] };
  if (scopeFilter.mode === 'exact') return { sql: ` AND ${col}scope = ?`, params: [scopeFilter.value] };
  const admit = scopeAdmitSql(col, scopeFilter.ownScope);
  if (scopeFilter.mode === 'default-deny') return { sql: ` AND ${admit.sql}`, params: admit.params };
  // The trailing arm keeps a deliberately requested scope loadable, private or quarantined included.
  return { sql: ` AND (${admit.sql} OR ${col}scope = ?)`, params: [...admit.params, scopeFilter.value] };
}

/** One project name, or every name a project's rows carry. */
export type OriginFilter = string | readonly string[];

// In SQL, not after the window cut, so other projects' matches cannot crowd the project's own rows out of the LIMIT.
function withProject(scope: SqlFragment, col: 'm.' | '', origin: OriginFilter | undefined): SqlFragment {
  if (origin === undefined) return scope;
  // A string is the shape published callers passed before a project could carry several names.
  const originProjects = [origin].flat();
  return { sql: `${scope.sql} AND (${col}origin_project = '' OR ${originInSql(originProjects, `${col}origin_project`)})`, params: [...scope.params, ...originProjects] };
}

/** Scope rule for recall: none requested is default-deny; 'exact' narrows to the request; 'additive' adds it to the default set, unless it is personal, which only `ownScope` opens. */
export function recallScopeFilter(requestedScope: string | undefined, mode: 'exact' | 'additive', ownScope?: string): RecallScopeFilter {
  if (!requestedScope || (mode === 'additive' && isPersonalScope(requestedScope))) return { mode: 'default-deny', ownScope };
  return mode === 'additive' ? { mode: 'default-deny-or-exact', value: requestedScope, ownScope } : { mode: 'exact', value: requestedScope };
}

const FTS_QUERY_SYNTAX_RE = /fts5: syntax error|unterminated string/i;

/** SQL predicate fragments every candidate path appends, built once per load. */
interface SearchPredicates {
  tenantPredicate: string;
  tenantOnlyPredicate: string;
  tenantParams: string[];
  archivedClauseAlias: string;
  archivedClauseTenantOnly: string;
  aliasScope: SqlFragment;
  plainScope: SqlFragment;
  scopeParams: string[];
  currentAlias: string;
  currentNoAlias: string;
}

let forceLikePath = false;

/** Sends term queries down the LIKE path on a build that has FTS. Only tests call it. */
export function _forceLikePathForTests(on: boolean): void {
  forceLikePath = on;
}

interface SearchRowsOptions {
  readonly scopeFilter?: RecallScopeFilter;
  readonly includeSuperseded?: boolean;
  readonly originProjects?: OriginFilter;
}

function loadSearchRows(
  db: ReturnType<typeof openHippoDb>,
  query: string,
  limit: number,
  tenantId: string | undefined,
  options: SearchRowsOptions = {},
): MemoryRow[] {
  const { scopeFilter, includeSuperseded = true, originProjects } = options;
  const p = searchPredicates(tenantId, scopeFilter, includeSuperseded, originProjects);

  const terms = Array.from(new Set(tokenize(query)));
  if (terms.length === 0) {
    // LIMIT here too, so every candidate path honours the caller's cap.
    return selectAllCandidates(db, p, limit);
  }

  // The test switch is read here, not in `isFtsAvailable`, so writes never skip FTS index sync.
  if (!forceLikePath && isFtsAvailable(db)) {
    const rows = selectFtsCandidates(db, terms, p, limit);
    if (rows.length > 0) return rows;
  }

  const rows = selectLikeCandidates(db, terms, p, limit);
  if (rows.length > 0) return rows;

  // LIMIT the full-store fallback too: RecallResult reports the scorer window, so an
  // unbounded fallback would misstate the candidate-pool size.
  return selectAllCandidates(db, p, limit);
}

function searchPredicates(
  tenantId: string | undefined,
  scopeFilter: RecallScopeFilter | undefined,
  includeSuperseded: boolean,
  originProjects: OriginFilter | undefined,
): SearchPredicates {
  // tenantId undefined = no tenant filter (legacy callers / cross-deployment
  // helpers). tenantId set = strict tenant isolation, leveraging the composite
  // idx_memories_tenant_created (leading column tenant_id, O(log n) lookup).
  const tenantPredicate = tenantId !== undefined ? ` AND m.tenant_id = ?` : '';
  const tenantOnlyPredicate = tenantId !== undefined ? ` WHERE tenant_id = ?` : '';
  const tenantParams = tenantId !== undefined ? [tenantId] : [];

  // Defensive: kind='archived' is a transient sentinel inside archiveRawMemory's SAVEPOINT, so this only
  // guards against a dropped SAVEPOINT, a persisted 'archived' state, or direct-SQL writes.
  const archivedClauseAlias = ` AND m.kind != 'archived'`;
  // For the "tenant-only" path: if no tenant set, tenantOnlyPredicate is '',
  // so prepend WHERE; if tenant set, append AND. handled in each call site
  // by always joining `tenantOnlyPredicate + archivedClauseTenantOnly` where
  // the latter switches between " AND" and " WHERE" based on caller context.
  const archivedClauseTenantOnly =
    tenantId !== undefined ? ` AND kind != 'archived'` : ` WHERE kind != 'archived'`;

  const aliasScope = withProject(recallScopeClause('m.', scopeFilter), 'm.', originProjects);
  const plainScope = withProject(recallScopeClause('', scopeFilter), '', originProjects);
  const scopeParams = aliasScope.params;

  const currentAlias = includeSuperseded ? '' : ' AND m.superseded_by IS NULL';
  const currentNoAlias = includeSuperseded ? '' : ' AND superseded_by IS NULL';
  return {
    tenantPredicate, tenantOnlyPredicate, tenantParams,
    archivedClauseAlias, archivedClauseTenantOnly,
    aliasScope, plainScope, scopeParams, currentAlias, currentNoAlias,
  };
}

/** Every admitted row, oldest first; the no-terms path and the last-resort fallback share it. */
function selectAllCandidates(db: DatabaseSyncLike, p: SearchPredicates, limit: number): MemoryRow[] {
  const sql = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories${p.tenantOnlyPredicate}${p.archivedClauseTenantOnly}${p.plainScope.sql}${p.currentNoAlias} ORDER BY created ASC, id ASC LIMIT ?`;
  // SAFETY: sql selects exactly MEMORY_SELECT_COLUMNS, whose column list
  // matches MemoryRow's field set.
  return db.prepare(sql).all(...p.tenantParams, ...p.scopeParams, limit) as MemoryRow[];
}

/** FTS5 bm25 matches; empty when none match or FTS5 cannot run the query. */
function selectFtsCandidates(db: DatabaseSyncLike, terms: string[], p: SearchPredicates, limit: number): MemoryRow[] {
  try {
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    // memories_fts virtual table has no tenant_id column; filter via the
    // joined memories row (cheap with idx_memories_tenant_created leading
    // on tenant_id).
    // SAFETY: MEMORY_SEARCH_COLUMNS aliases every column to the same name
    // MEMORY_SELECT_COLUMNS uses (plus bm25_score), matching MemoryRow.
    return db.prepare(`
        SELECT ${MEMORY_SEARCH_COLUMNS}
        FROM memories m
        JOIN memories_fts f ON f.id = m.id
        WHERE memories_fts MATCH ?${p.tenantPredicate}${p.archivedClauseAlias}${p.aliasScope.sql}${p.currentAlias}
        ORDER BY bm25(memories_fts), m.updated_at DESC, m.content ASC, m.id ASC
        LIMIT ?
      `).all(ftsQuery, ...p.tenantParams, ...p.scopeParams, limit) as MemoryRow[];
  } catch (err) {
    // A query FTS5 cannot parse is expected input; anything else means the index itself is broken.
    const message = err instanceof Error ? err.message : String(err);
    if (!FTS_QUERY_SYNTAX_RE.test(message)) log.once('fts-match-fallback', 'warn', `FTS search failed, using the slower LIKE match: ${message}`);
    return [];
  }
}

/** Newest admitted rows the substring match tests, so a query matching nothing costs the same in a store of any size. */
const LIKE_WINDOW_ROWS = 2000;

/** Substring matches in content or tags among the newest admitted rows: the lexical path without FTS5, and the catch for a part-word that FTS5 tokens miss. */
function selectLikeCandidates(db: DatabaseSyncLike, terms: string[], p: SearchPredicates, limit: number): MemoryRow[] {
  const where = terms.map(() => `(LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(tags_json) LIKE ? ESCAPE '\\')`).join(' OR ');
  const params = terms.flatMap((term) => {
    const like = `%${escapeLike(term)}%`;
    return [like, like];
  });
  // idx_memories_tenant_created serves a tenant's newest rows; with no tenant only the table's own order needs no sort.
  const newestFirst = p.tenantParams.length > 0 ? 'created DESC' : 'rowid DESC';

  // SHORTCUT: no index serves a substring, so a match older than the window is missed; an FTS5 trigram index is the upgrade.
  // SAFETY: the outer query selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  return db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM (
      SELECT ${MEMORY_SELECT_COLUMNS}, updated_at
      FROM memories${p.tenantOnlyPredicate}${p.archivedClauseTenantOnly}${p.plainScope.sql}${p.currentNoAlias}
      ORDER BY ${newestFirst}
      LIMIT ?
    )
    WHERE (${where})
    ORDER BY updated_at DESC, created DESC, content ASC, id ASC
    LIMIT ?
  `).all(...p.tenantParams, ...p.scopeParams, Math.max(limit, LIKE_WINDOW_ROWS), ...params, limit) as MemoryRow[];
}

/**
 * Load likely search candidates directly from SQLite.
 * Uses FTS5 when available, falls back to LIKE matching, then full-store fallback.
 *
 * When `tenantId` is provided, every SELECT (FTS join, LIKE, fallback) filters
 * by tenant_id. Cross-tenant memories never surface. Omitted = no filter.
 */
export function loadSearchEntries(
  hippoRoot: string,
  query: string,
  limit: number = DEFAULT_SEARCH_CANDIDATE_LIMIT,
  tenantId?: string,
): MemoryEntry[] {
  const db = openStore(hippoRoot);
  try {
    return loadSearchRows(db, query, limit, tenantId).map(rowToEntry);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Recall-mode loader. Pushes the recall-side scope predicate into SQL so
 * `unknown:legacy` cannot leak via any consumer that hasn't remembered to re-filter.
 *
 * - `requestedScope` undefined / '': default-deny on `unknown:legacy`, admitting `ownScope`, the caller's personal scope.
 * - `requestedScope` non-empty string: exact match on `m.scope = requestedScope`.
 *
 * Private scopes: SQL applies a conservative `NOT LIKE '%:private:%'` before the LIMIT window so private
 * rows cannot starve admitted ones; `passesScopeFilterForRecall` stays the exact JS post-filter.
 *
 * Consumers: `api.recall`, `cmdRecall`/`cmdExplain` direct CLI paths
 * and `searchBothHybrid` recall mode. Background pipelines
 * (`consolidate`, `embeddings`, `refine-llm`, ...) keep using
 * `loadSearchEntries` so they can see quarantined rows when needed.
 *
 * `tenantId` is optional because searchBothHybrid's is; undefined means no tenant filter.
 */
export function loadRecallSearchEntries(
  hippoRoot: string,
  query: string,
  limit: number = DEFAULT_SEARCH_CANDIDATE_LIMIT,
  tenantId?: string,
  requestedScope?: string,
  explicitScopeMode: 'exact' | 'additive' = 'exact',
  includeSuperseded = true,
  originProjects?: OriginFilter,
  ownScope?: string,
): MemoryEntry[] {
  const db = openStore(hippoRoot);
  try {
    return loadRecallSearchEntriesFromDb(db, query, { limit, tenantId, requestedScope, explicitScopeMode, includeSuperseded, originProjects, ownScope });
  } finally {
    closeHippoDb(db);
  }
}

export interface RecallSearchEntriesOptions {
  readonly limit?: number;
  readonly tenantId?: string;
  readonly requestedScope?: string;
  readonly explicitScopeMode?: 'exact' | 'additive';
  readonly includeSuperseded?: boolean;
  readonly originProjects?: OriginFilter;
  readonly ownScope?: string;
}

// Split out so callers with an already-open db (the prompt-recall path) skip
// the initStore+open/close cycle per store per call.
export function loadRecallSearchEntriesFromDb(
  db: DatabaseSyncLike,
  query: string,
  options: RecallSearchEntriesOptions = {},
): MemoryEntry[] {
  const { limit = DEFAULT_SEARCH_CANDIDATE_LIMIT, tenantId, requestedScope, explicitScopeMode = 'exact', includeSuperseded = true, originProjects, ownScope } = options;
  const scopeFilter = recallScopeFilter(requestedScope, explicitScopeMode, ownScope);
  return loadSearchRows(db, query, limit, tenantId, { scopeFilter, includeSuperseded, originProjects }).map(rowToEntry);
}

/** Which rows the vector arm of hybrid search may add: the same tenant, scope and superseded rules as the lexical load. */
export interface VectorCandidateSpec {
  tenantId?: string;
  scope?: RecallScopeFilter;
  includeSuperseded: boolean;
  /** How many nearest rows to add; default 50. */
  limit?: number;
  origin?: OriginFilter;
}

/** The rows nearest `queryVector` that pass `spec`, nearest first. */
export async function loadVectorCandidateEntries(hippoRoot: string, queryVector: readonly number[], spec: VectorCandidateSpec): Promise<MemoryEntry[]> {
  const scope = withProject(recallScopeClause('m.', spec.scope), 'm.', spec.origin);
  const tenant = spec.tenantId !== undefined ? ' AND m.tenant_id = ?' : '';
  const current = spec.includeSuperseded ? '' : ' AND m.superseded_by IS NULL';
  const params = [...(spec.tenantId !== undefined ? [spec.tenantId] : []), ...scope.params];
  const db = openStore(hippoRoot);
  try {
    const matches = await topVectorMatches(db, queryVector, spec.limit ?? 50, `${tenant} AND m.kind != 'archived'${scope.sql}${current}`, params);
    if (matches.length === 0) return [];
    // SAFETY: the SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const rows = db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${matches.map(() => '?').join(', ')})`)
      .all(...matches.map((m) => m.id)) as MemoryRow[];
    const byId = new Map(rows.map((r) => [r.id, rowToEntry(r)]));
    return matches.flatMap((m) => byId.get(m.id) ?? []);
  } finally {
    closeHippoDb(db);
  }
}

/** Rarest-K prompt terms for this connection's FTS index, as a space-joined query string.
 *  Without FTS, returns the first 32 terms, as before rarest-term selection. */
export function pickRarestFtsQuery(db: DatabaseSyncLike, terms: readonly string[], maxTerms = RAREST_TERM_COUNT): string {
  // The LIKE path has no bm25 ranking to bound, so it keeps the pre-rarest 32-term query.
  if (!isFtsAvailable(db)) return terms.slice(0, 32).join(' ');
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.z1_rarest_vocab USING fts5vocab(main, 'memories_fts', 'row')`);
  const vocab = Array.from(new Set(terms.flatMap(ftsTermParts)));
  if (vocab.length === 0) return '';
  // SAFETY: rows' shape matches the two columns named in the SELECT.
  const rows = db
    .prepare(`SELECT term, doc FROM temp.z1_rarest_vocab WHERE term IN (${vocab.map(() => '?').join(', ')})`)
    .all(...vocab) as Array<{ term: string; doc: number }>;
  const counts = new Map(rows.map((r) => [r.term, r.doc]));
  return rarestFtsQuery(terms, (part) => counts.get(part) ?? 0, maxTerms);
}
