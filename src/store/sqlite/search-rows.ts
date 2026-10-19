import type { MemoryEntry } from '../../core/memory.js';
import { openHippoDb, isFtsAvailable, type DatabaseSyncLike } from '../../db/index.js';
import { tokenize } from '../../util/tokenize.js';
import { recallScopeFilter, type RecallScopeFilter } from '../../core/recall-scope.js';
import { scopeAdmitSql, type SqlFragment } from './rule-sql.js';
import { ftsTermParts, RAREST_TERM_COUNT, rarestFtsQuery } from '../../core/prompt-recall.js';
import { errorMessage, log, errorFields } from '../../util/log.js';
import { originInSql } from '../../core/project-identity.js';
import { topVectorMatches, type VectorIndex } from '../../db/vector-store.js';
import { type MemoryRow, MEMORY_SELECT_COLUMNS, MEMORY_SEARCH_COLUMNS, rowToEntry } from './rows.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../../core/search-types.js';
import { cachedStatement } from './statement-cache.js';
import { escapeLike } from '../../util/escape.js';
import { placeholders } from '../../util/sql.js';
import type { OriginFilter } from '../port/types.js';
import type { RecallSearchEntriesOptions } from '../port/sharing.js';
import type { VectorCandidateSpec } from '../port/vector-reads.js';
import { ALL_TENANTS, type TenantId } from '../../util/tenant.js';
import { tenantAnd } from './tenant.js';

/** The recall scope rule for a table column prefix (`m.` or none); `passesScopeFilterForRecall` in recall-scope.ts is
 * its JS twin. */
function recallScopeClause(col: 'm.' | '', scopeFilter: RecallScopeFilter | undefined): SqlFragment {
  if (scopeFilter === undefined) return { sql: '', params: [] };
  if (scopeFilter.mode === 'exact') return { sql: ` AND ${col}scope = ?`, params: [scopeFilter.value] };
  const admit = scopeAdmitSql(col, scopeFilter.ownScope);
  if (scopeFilter.mode === 'default-deny') return { sql: ` AND ${admit.sql}`, params: admit.params };
  // The trailing arm keeps a deliberately requested scope loadable, private or quarantined included.
  return { sql: ` AND (${admit.sql} OR ${col}scope = ?)`, params: [...admit.params, scopeFilter.value] };
}

// In SQL, not after the window cut, so other projects' matches cannot crowd the project's own rows out of the LIMIT.
function withProject(scope: SqlFragment, col: 'm.' | '', origin: OriginFilter | undefined): SqlFragment {
  if (origin === undefined) return scope;
  // A string is the shape published callers passed before a project could carry several names.
  const originProjects = [origin].flat();
  return {
    sql: `${scope.sql} AND (${col}origin_project = '' OR ${originInSql(originProjects, `${col}origin_project`)})`,
    params: [...scope.params, ...originProjects],
  };
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

interface SearchRowsOptions {
  readonly scopeFilter?: RecallScopeFilter;
  readonly includeSuperseded?: boolean;
  readonly originProjects?: OriginFilter;
}

function loadSearchRows(
  db: ReturnType<typeof openHippoDb>,
  query: string,
  limit: number,
  tenantId: TenantId,
  options: SearchRowsOptions = {},
): MemoryRow[] {
  const { scopeFilter, includeSuperseded = true, originProjects } = options;
  const p = searchPredicates(tenantId, scopeFilter, includeSuperseded, originProjects);

  const terms = Array.from(new Set(tokenize(query)));
  if (terms.length === 0) {
    // LIMIT here too, so every candidate path honours the caller's cap.
    return selectAllCandidates(db, p, limit);
  }

  if (isFtsAvailable(db)) {
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
  tenantId: TenantId,
  scopeFilter: RecallScopeFilter | undefined,
  includeSuperseded: boolean,
  originProjects: OriginFilter | undefined,
): SearchPredicates {
  // One tenant reads through the composite idx_memories_tenant_created.
  const one = tenantId !== ALL_TENANTS;
  const tenantPredicate = tenantAnd(tenantId, 'm.tenant_id = ?').sql;
  const tenantOnlyPredicate = one ? ` WHERE tenant_id = ?` : '';
  const tenantParams = tenantAnd(tenantId).args;

  // Defensive: kind='archived' is a transient sentinel inside archiveRawMemory's SAVEPOINT, so this only
  // guards against a dropped SAVEPOINT, a persisted 'archived' state, or direct-SQL writes.
  const archivedClauseAlias = ` AND m.kind != 'archived'`;
  // Tenant-only path: for every tenant `tenantOnlyPredicate` is '', so the archived clause switches between ' AND' and
  // ' WHERE' by caller context.
  const archivedClauseTenantOnly = one ? ` AND kind != 'archived'` : ` WHERE kind != 'archived'`;

  const aliasScope = withProject(recallScopeClause('m.', scopeFilter), 'm.', originProjects);
  const plainScope = withProject(recallScopeClause('', scopeFilter), '', originProjects);
  const scopeParams = aliasScope.params;

  const currentAlias = includeSuperseded ? '' : ' AND m.superseded_by IS NULL';
  const currentNoAlias = includeSuperseded ? '' : ' AND superseded_by IS NULL';
  return {
    tenantPredicate,
    tenantOnlyPredicate,
    tenantParams,
    archivedClauseAlias,
    archivedClauseTenantOnly,
    aliasScope,
    plainScope,
    scopeParams,
    currentAlias,
    currentNoAlias,
  };
}

/** Every admitted row, oldest first; the no-terms path and the last-resort fallback share it. */
function selectAllCandidates(db: DatabaseSyncLike, p: SearchPredicates, limit: number): MemoryRow[] {
  const sql =
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories${p.tenantOnlyPredicate}${p.archivedClauseTenantOnly}` +
    `${p.plainScope.sql}${p.currentNoAlias} ORDER BY created ASC, id ASC LIMIT ?`;
  // SAFETY: sql selects exactly MEMORY_SELECT_COLUMNS, whose column list
  // matches MemoryRow's field set.
  return cachedStatement(db, sql).all(...p.tenantParams, ...p.scopeParams, limit) as MemoryRow[];
}

/** FTS5 bm25 matches; empty when none match or FTS5 cannot run the query. */
function selectFtsCandidates(db: DatabaseSyncLike, terms: string[], p: SearchPredicates, limit: number): MemoryRow[] {
  try {
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    // memories_fts has no tenant_id column; filter via the joined memories row (cheap with
    // idx_memories_tenant_created). SAFETY: MEMORY_SEARCH_COLUMNS aliases every column like MEMORY_SELECT_COLUMNS (plus
    // bm25_score), matching MemoryRow.
    return cachedStatement(
      db,
      `
        SELECT ${MEMORY_SEARCH_COLUMNS}
        FROM memories m
        JOIN memories_fts f ON f.id = m.id
        WHERE memories_fts MATCH ?${p.tenantPredicate}${p.archivedClauseAlias}${p.aliasScope.sql}${p.currentAlias}
        ORDER BY bm25(memories_fts), m.updated_at DESC, m.content ASC, m.id ASC
        LIMIT ?
      `,
    ).all(ftsQuery, ...p.tenantParams, ...p.scopeParams, limit) as MemoryRow[];
  } catch (err) {
    // A query FTS5 cannot parse is expected input; anything else means the index itself is broken.
    const message = errorMessage(err);
    if (!FTS_QUERY_SYNTAX_RE.test(message)) {
      const failure = `FTS search failed, using the slower LIKE match: ${message}`;
      log.once('fts-match-fallback', 'warn', failure, errorFields(err));
    }
    return [];
  }
}

/** Newest admitted rows the substring match tests, so a query matching nothing costs the same in a store of any
 * size. */
const LIKE_WINDOW_ROWS = 2000;

/** Substring matches in content or tags among the newest admitted rows: the lexical path without FTS5, and the catch
 * for a part-word that FTS5 tokens miss. */
function selectLikeCandidates(db: DatabaseSyncLike, terms: string[], p: SearchPredicates, limit: number): MemoryRow[] {
  const where = terms
    .map(() => `(LOWER(content) LIKE ? ESCAPE '\\' OR LOWER(tags_json) LIKE ? ESCAPE '\\')`)
    .join(' OR ');
  const params = terms.flatMap((term) => {
    const like = `%${escapeLike(term)}%`;
    return [like, like];
  });
  // idx_memories_tenant_created serves a tenant's newest rows; with no tenant only the table's own order needs no sort.
  const newestFirst = p.tenantParams.length > 0 ? 'created DESC' : 'rowid DESC';

  // SHORTCUT: no index serves a substring, so a match older than the window is missed; an FTS5 trigram index is the
  // upgrade. SAFETY: the outer query selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  return cachedStatement(
    db,
    `
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
  `,
  ).all(...p.tenantParams, ...p.scopeParams, Math.max(limit, LIKE_WINDOW_ROWS), ...params, limit) as MemoryRow[];
}

/** Load likely search candidates: FTS5 when available, else LIKE, then full-store fallback. */
export function loadSearchEntriesAt(
  db: DatabaseSyncLike,
  query: string,
  limit: number = DEFAULT_SEARCH_CANDIDATE_LIMIT,
  tenantId: TenantId,
): MemoryEntry[] {
  return loadSearchRows(db, query, limit, tenantId).map(rowToEntry);
}

/** Recall-mode loader: scope predicate in SQL so `unknown:legacy` cannot leak. Empty `requestedScope` default-denies
 * (admits `ownScope`); else exact match. SQL `NOT LIKE '%:private:%'` runs before the LIMIT so private rows cannot
 * starve admitted ones; `passesScopeFilterForRecall` is the exact post-filter. */
export function loadRecallEntriesAt(
  db: DatabaseSyncLike,
  query: string,
  options: RecallSearchEntriesOptions,
): MemoryEntry[] {
  return loadRecallSearchEntriesFromDb(db, query, options);
}

// Split out so callers with an already-open db (the prompt-recall path) skip
// the initStore+open/close cycle per store per call.
export function loadRecallSearchEntriesFromDb(
  db: DatabaseSyncLike,
  query: string,
  options: RecallSearchEntriesOptions,
): MemoryEntry[] {
  const {
    limit = DEFAULT_SEARCH_CANDIDATE_LIMIT,
    tenantId,
    requestedScope,
    explicitScopeMode = 'exact',
    includeSuperseded = true,
    originProjects,
    ownScope,
  } = options;
  const scopeFilter = recallScopeFilter(requestedScope, explicitScopeMode, ownScope);
  return loadSearchRows(db, query, limit, tenantId, { scopeFilter, includeSuperseded, originProjects }).map(rowToEntry);
}

/** The rows nearest `queryVector` that pass `spec`, nearest first; `index` proposes them when it can. */
export async function loadVectorCandidateEntriesAt(
  db: DatabaseSyncLike,
  queryVector: readonly number[],
  spec: VectorCandidateSpec,
  index?: VectorIndex,
): Promise<MemoryEntry[]> {
  const scope = withProject(recallScopeClause('m.', spec.scope), 'm.', spec.origin);
  const tenant = tenantAnd(spec.tenantId, 'm.tenant_id = ?');
  const current = spec.includeSuperseded ? '' : ' AND m.superseded_by IS NULL';
  const params = [...tenant.args, ...scope.params];
  const matches = await topVectorMatches(db, {
    query: queryVector,
    k: spec.limit ?? 50,
    where: `${tenant.sql} AND m.kind != 'archived'${scope.sql}${current}`,
    params,
    index,
  });
  if (matches.length === 0) return [];
  // SAFETY: the SELECT names exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id IN (${placeholders(matches.length)})`,
  ).all(...matches.map((m) => m.id)) as MemoryRow[];
  const byId = new Map(rows.map((r) => [r.id, rowToEntry(r)]));
  return matches.flatMap((m) => byId.get(m.id) ?? []);
}

/** Rarest-K prompt terms for this connection's FTS index, as a space-joined query string.
 *  Without FTS, returns the first 32 terms, as before rarest-term selection. */
export function pickRarestFtsQuery(
  db: DatabaseSyncLike,
  terms: readonly string[],
  maxTerms = RAREST_TERM_COUNT,
): string {
  // The LIKE path has no bm25 ranking to bound, so it keeps the pre-rarest 32-term query.
  if (!isFtsAvailable(db)) return terms.slice(0, 32).join(' ');
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.z1_rarest_vocab USING fts5vocab(main, 'memories_fts', 'row')`);
  const vocab = Array.from(new Set(terms.flatMap(ftsTermParts)));
  if (vocab.length === 0) return '';
  // SAFETY: rows' shape matches the two columns named in the SELECT.
  const rows = cachedStatement(
    db,
    `SELECT term, doc FROM temp.z1_rarest_vocab WHERE term IN (${placeholders(vocab.length)})`,
  ).all(...vocab) as Array<{ term: string; doc: number }>;
  const counts = new Map(rows.map((r) => [r.term, r.doc]));
  return rarestFtsQuery(terms, (part) => counts.get(part) ?? 0, maxTerms);
}
