import { envForceLikePath } from '../env.js';
import type { MemoryEntry } from '../memory.js';
import { openHippoDb, isFtsAvailable, closeHippoDb, type DatabaseSyncLike } from '../db.js';
import { tokenize } from '../tokenize.js';
import { RECALL_DEFAULT_DENY_SCOPES } from '../recall-scope.js';
import { RAREST_TERM_COUNT, rarestPromptTerms } from '../prompt-recall.js';
import { log } from '../log.js';
import { topVectorMatches } from '../vector-store.js';
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
 * v1.7.2 — recall-mode scope filter shape, exported so callers
 * (`loadRecallSearchEntries`) and tests can refer to it symbolically without
 * `Parameters<typeof loadSearchRows>[N]` indirection.
 *
 * Three modes:
 *   - 'default-deny' — exclude scopes in `RECALL_DEFAULT_DENY_SCOPES` (T2).
 *   - 'exact' — exact match on `m.scope = value` (api.recall's explicit-scope
 *     request semantics).
 *   - 'default-deny-or-exact' (v1.25.0) — the default-admitted set PLUS rows
 *     whose scope equals `value`. This is the CLI `--scope` semantics: the
 *     flag predates the envelope column as a TAG-boost ranking hint
 *     (`scope:<v>` tags, HIPPO_SCOPE), so an explicit flag must UNLOCK the
 *     named envelope scope in addition to the normal set rather than narrow
 *     the result to it — narrowing would return zero rows for every
 *     tag-scoped workflow (envelope scope NULL). Strictly safer than the
 *     pre-v1.25.0 CLI behavior (no filter at all): other private scopes and
 *     quarantine buckets stay denied.
 *
 * Background pipelines (`consolidate`, `embeddings`, `refine-llm`, ...) call
 * `loadSearchEntries` (no scopeFilter arg) and see all rows including
 * quarantine.
 */
/** @internal v1.7.2 — internal SQL-builder shape; not on the public API
 *  surface (not re-exported from `src/index.ts`). Subject to change. */
export type RecallScopeFilter =
  | { mode: 'default-deny' }
  | { mode: 'exact'; value: string }
  | { mode: 'default-deny-or-exact'; value: string };

interface SqlFragment {
  sql: string;
  params: string[];
}

/** The recall scope rule for a table column prefix (`m.` or none); `passesScopeFilterForRecall` in recall-scope.ts is its JS twin. */
function recallScopeClause(col: 'm.' | '', scopeFilter: RecallScopeFilter | undefined): SqlFragment {
  if (scopeFilter === undefined) return { sql: '', params: [] };
  if (scopeFilter.mode === 'exact') return { sql: ` AND ${col}scope = ?`, params: [scopeFilter.value] };
  // `IS NULL OR` admits NULL scopes, which NOT IN alone drops. NOT LIKE denies a superset of private scopes before the
  // window cut so private rows cannot starve admitted ones; the anchored JS regex stays the exact post-filter.
  const placeholders = RECALL_DEFAULT_DENY_SCOPES.map(() => '?').join(', ');
  const admitted = `${col}scope IS NULL OR (${col}scope NOT IN (${placeholders}) AND ${col}scope NOT LIKE '%:private:%')`;
  if (scopeFilter.mode === 'default-deny') return { sql: ` AND (${admitted})`, params: [...RECALL_DEFAULT_DENY_SCOPES] };
  // The trailing arm keeps a deliberately requested scope loadable, private or quarantined included.
  return { sql: ` AND (${admitted} OR ${col}scope = ?)`, params: [...RECALL_DEFAULT_DENY_SCOPES, scopeFilter.value] };
}

// In SQL, not after the window cut, so other projects' matches cannot crowd the project's own rows out of the LIMIT.
function withProject(scope: SqlFragment, col: 'm.' | '', originProject: string | undefined): SqlFragment {
  if (originProject === undefined) return scope;
  return { sql: `${scope.sql} AND (${col}origin_project = '' OR ${col}origin_project = ?)`, params: [...scope.params, originProject] };
}

/** Scope rule for recall: none requested is default-deny; 'exact' narrows to the request; 'additive' adds it to the default set. */
export function recallScopeFilter(requestedScope: string | undefined, mode: 'exact' | 'additive'): RecallScopeFilter {
  if (!requestedScope) return { mode: 'default-deny' };
  return mode === 'additive' ? { mode: 'default-deny-or-exact', value: requestedScope } : { mode: 'exact', value: requestedScope };
}

const FTS_QUERY_SYNTAX_RE = /fts5: syntax error|unterminated string/i;

/** SQL predicate fragments every candidate path appends, built once per load. */
interface SearchPredicates {
  tenantPredicate: string;
  tenantPredicateNoAlias: string;
  tenantOnlyPredicate: string;
  tenantParams: string[];
  archivedClauseAlias: string;
  archivedClauseNoAlias: string;
  archivedClauseTenantOnly: string;
  aliasScope: SqlFragment;
  plainScope: SqlFragment;
  scopeParams: string[];
  currentAlias: string;
  currentNoAlias: string;
}

function loadSearchRows(
  db: ReturnType<typeof openHippoDb>,
  query: string,
  limit: number,
  tenantId: string | undefined,
  scopeFilter?: RecallScopeFilter,
  includeSuperseded = true,
  originProject?: string,
): MemoryRow[] {
  const p = searchPredicates(tenantId, scopeFilter, includeSuperseded, originProject);

  const terms = Array.from(new Set(tokenize(query)));
  if (terms.length === 0) {
    // F3 (v1.7.0) self-review: empty-query path is the second uncapped
    // path (codex diff-pass caught the full-store fallback at the bottom;
    // this no-terms path had the same shape). Apply LIMIT so all four
    // candidate paths honour the caller's cap when set.
    return selectAllCandidates(db, p, limit);
  }

  // v1.7.1 — test/diagnostic hook: `HIPPO_FORCE_LIKE_PATH=1` forces the
  // LIKE-fallback path here only. Gated at the read-call site so writes
  // (`syncFtsRow`, `deleteFtsRow`, `raw-archive.ts::archiveRaw`) keep using
  // `isFtsAvailable` honestly and never silently skip FTS index sync.
  // Lets tests exercise the LIKE branch deterministically without
  // poisoning the on-disk FTS state.
  const forceLikePath = envForceLikePath();
  if (!forceLikePath && isFtsAvailable(db)) {
    const rows = selectFtsCandidates(db, terms, p, limit);
    if (rows.length > 0) return rows;
  }

  const rows = selectLikeCandidates(db, terms, p, limit);
  if (rows.length > 0) return rows;

  // F3 (v1.7.0) codex P1: pre-v1.7.0 the full-store fallback ignored
  // `limit` and could return the whole tenant store. With scorerWindow
  // now reported on RecallResult, an unbounded fallback would lie about
  // candidate-pool size. Apply LIMIT here so all four paths honour the
  // caller's cap.
  return selectAllCandidates(db, p, limit);
}

function searchPredicates(
  tenantId: string | undefined,
  scopeFilter: RecallScopeFilter | undefined,
  includeSuperseded: boolean,
  originProject: string | undefined,
): SearchPredicates {
  // tenantId undefined = no tenant filter (legacy callers / cross-deployment
  // helpers). tenantId set = strict tenant isolation, leveraging the composite
  // idx_memories_tenant_created (leading column tenant_id, O(log n) lookup).
  const tenantPredicate = tenantId !== undefined ? ` AND m.tenant_id = ?` : '';
  const tenantPredicateNoAlias = tenantId !== undefined ? ` AND tenant_id = ?` : '';
  const tenantOnlyPredicate = tenantId !== undefined ? ` WHERE tenant_id = ?` : '';
  const tenantParams = tenantId !== undefined ? [tenantId] : [];

  // v1.12.6 — belt-and-suspenders against `kind='archived'` leaking into recall.
  // `kind='archived'` is a transient sentinel inside `archiveRawMemory`'s
  // SAVEPOINT (src/raw-archive.ts:56): UPDATE kind = 'archived' immediately
  // followed by DELETE, both inside one savepoint that commits or rolls back
  // atomically. SQLite atomicity guarantees no concurrent reader sees the
  // intermediate state. This filter is defensive-only against:
  //   (a) future bugs that drop the SAVEPOINT,
  //   (b) future bugs that introduce kind='archived' as a persisted state,
  //   (c) external direct-SQL writes that bypass archiveRawMemory.
  // tenantOnlyPredicate starts with " WHERE tenant_id = ?" when tenant is set;
  // when unset, we have no WHERE yet, so the archived clause needs both AND
  // and WHERE forms. The "tenant-only" path always has WHERE (from tenant or
  // we synthesize one).
  const archivedClauseAlias = ` AND m.kind != 'archived'`;
  const archivedClauseNoAlias = ` AND kind != 'archived'`;
  // For the "tenant-only" path: if no tenant set, tenantOnlyPredicate is '',
  // so prepend WHERE; if tenant set, append AND. handled in each call site
  // by always joining `tenantOnlyPredicate + archivedClauseTenantOnly` where
  // the latter switches between " AND" and " WHERE" based on caller context.
  const archivedClauseTenantOnly =
    tenantId !== undefined ? ` AND kind != 'archived'` : ` WHERE kind != 'archived'`;

  const aliasScope = withProject(recallScopeClause('m.', scopeFilter), 'm.', originProject);
  const plainScope = withProject(recallScopeClause('', scopeFilter), '', originProject);
  const scopeParams = aliasScope.params;

  const currentAlias = includeSuperseded ? '' : ' AND m.superseded_by IS NULL';
  const currentNoAlias = includeSuperseded ? '' : ' AND superseded_by IS NULL';
  return {
    tenantPredicate, tenantPredicateNoAlias, tenantOnlyPredicate, tenantParams,
    archivedClauseAlias, archivedClauseNoAlias, archivedClauseTenantOnly,
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
    // F1 (v1.7.0): MEMORY_SEARCH_COLUMNS adds bm25_score as the trailing
    // result column. Every other column is m.<col> AS <col> so rowToEntry
    // sees the same shape it always has.
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

function selectLikeCandidates(db: DatabaseSyncLike, terms: string[], p: SearchPredicates, limit: number): MemoryRow[] {
  const where = terms.map(() => `(LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(tags_json) LIKE ? ESCAPE '\\')`).join(' OR ');
  const params = terms.flatMap((term) => {
    const like = `%${escapeLike(term)}%`;
    return [like, like];
  });

  // SAFETY: this query selects exactly MEMORY_SELECT_COLUMNS, matching
  // MemoryRow's field set.
  return db.prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS}
    FROM memories
    WHERE (${where})${p.tenantPredicateNoAlias}${p.archivedClauseNoAlias}${p.plainScope.sql}${p.currentNoAlias}
    ORDER BY updated_at DESC, created DESC, content ASC, id ASC
    LIMIT ?
  `).all(...params, ...p.tenantParams, ...p.scopeParams, limit) as MemoryRow[];
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
 * v1.7.1 — recall-mode loader. Pushes the recall-side scope predicate into
 * SQL so `unknown:legacy` cannot leak via any consumer that hasn't remembered
 * to re-filter (root-cause-over-patches: codex flagged this on v1.6.5 review).
 *
 * - `requestedScope` undefined / '': default-deny on `unknown:legacy`.
 * - `requestedScope` non-empty string: exact match on `m.scope = requestedScope`.
 *
 * Private-scope (`<source>:private:*`) exclusion: SQL applies a conservative
 * pre-window approximation (`NOT LIKE '%:private:%'`, v1.25.0 — codex P2:
 * post-window-only filtering let private rows starve admitted candidates out
 * of the LIMIT window); the exact anchored regex
 * (`passesScopeFilterForRecall`) remains the authoritative JS post-filter in
 * the recall consumers.
 *
 * Consumers: `api.recall` (v1.7.1+), `cmdRecall`/`cmdExplain` direct CLI paths
 * and `searchBothHybrid` recall mode (v1.25.0). Background pipelines
 * (`consolidate`, `embeddings`, `refine-llm`, ...) keep using
 * `loadSearchEntries` so they can see quarantined rows when needed.
 *
 * `tenantId` widened to optional in v1.25.0 for the searchBothHybrid recall
 * mode (its `tenantId` option is optional); `loadSearchRows` already treats
 * undefined as "no tenant filter" for legacy callers.
 */
export function loadRecallSearchEntries(
  hippoRoot: string,
  query: string,
  limit: number = DEFAULT_SEARCH_CANDIDATE_LIMIT,
  tenantId?: string,
  requestedScope?: string,
  explicitScopeMode: 'exact' | 'additive' = 'exact',
  includeSuperseded = true,
  originProject?: string,
): MemoryEntry[] {
  const db = openStore(hippoRoot);
  try {
    return loadRecallSearchEntriesFromDb(db, query, limit, tenantId, requestedScope, explicitScopeMode, includeSuperseded, originProject);
  } finally {
    closeHippoDb(db);
  }
}

// Split out so callers with an already-open db (Z1 prompt-recall path) skip
// the initStore+open/close cycle per store per call.
export function loadRecallSearchEntriesFromDb(
  db: DatabaseSyncLike,
  query: string,
  limit: number = DEFAULT_SEARCH_CANDIDATE_LIMIT,
  tenantId?: string,
  requestedScope?: string,
  explicitScopeMode: 'exact' | 'additive' = 'exact',
  includeSuperseded = true,
  originProject?: string,
): MemoryEntry[] {
  return loadSearchRows(db, query, limit, tenantId, recallScopeFilter(requestedScope, explicitScopeMode), includeSuperseded, originProject).map(rowToEntry);
}

/** Which rows the vector arm of hybrid search may add: the same tenant, scope and superseded rules as the lexical load. */
export interface VectorCandidateSpec {
  tenantId?: string;
  scope?: RecallScopeFilter;
  includeSuperseded: boolean;
  /** How many nearest rows to add; default 50. */
  limit?: number;
}

/** The rows nearest `queryVector` that pass `spec`, nearest first. */
export function loadVectorCandidateEntries(hippoRoot: string, queryVector: readonly number[], spec: VectorCandidateSpec): MemoryEntry[] {
  const scope = recallScopeClause('m.', spec.scope);
  const tenant = spec.tenantId !== undefined ? ' AND m.tenant_id = ?' : '';
  const current = spec.includeSuperseded ? '' : ' AND m.superseded_by IS NULL';
  const params = [...(spec.tenantId !== undefined ? [spec.tenantId] : []), ...scope.params];
  const db = openStore(hippoRoot);
  try {
    const matches = topVectorMatches(db, queryVector, spec.limit ?? 50, `${tenant} AND m.kind != 'archived'${scope.sql}${current}`, params);
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
  // unicode61 splits `journal_mode` into two vocab terms; a term's count is its rarest part's (an upper bound).
  const partsOf = (t: string): string[] => t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const vocab = Array.from(new Set(terms.flatMap(partsOf)));
  if (vocab.length === 0) return '';
  // SAFETY: rows' shape matches the two columns named in the SELECT.
  const rows = db
    .prepare(`SELECT term, doc FROM temp.z1_rarest_vocab WHERE term IN (${vocab.map(() => '?').join(', ')})`)
    .all(...vocab) as Array<{ term: string; doc: number }>;
  const counts = new Map(rows.map((r) => [r.term, r.doc]));
  const docCount = (t: string): number => {
    const parts = partsOf(t);
    return parts.length === 0 ? 0 : Math.min(...parts.map((x) => counts.get(x) ?? 0));
  };
  return rarestPromptTerms(terms, docCount, maxTerms).join(' ');
}
