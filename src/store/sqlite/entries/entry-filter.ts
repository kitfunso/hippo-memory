import { keysetPage } from '../../../base/util/keyset.js';
import { ALL_TENANTS } from '../../../base/util/tenant.js';
import type { DatabaseSyncLike } from '../../../db/index.js';
import type { SqlFragment } from '../../../db/sql.js';
import { notSupersededAt } from '../../../db/sql-predicates.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import type { EntryFilter, EntryNarrowing } from '../../../base/ports/store/reports.js';
import type { EntryCursor, EntryPage } from '../../../base/ports/store/types.js';
import {
  entriesPage,
  entryPageOrder,
  entryRange,
  type EntryPageRequest,
} from '../runtime/keyset.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from '../runtime/rows.js';
import { tagsOf } from '../runtime/rule-sql.js';
import { tenantAnd, TENANT_IS } from '../runtime/tenant.js';

/** A memories column a filter reads; a dormant snapshot answers each from its JSON field of the
 * same name. */
export type FilterColumn =
  | 'id'
  | 'origin_project'
  | 'source'
  | 'artifact_ref'
  | 'tags_json'
  | 'kind'
  | 'superseded_by'
  | 'source_session_id';

type ColumnOf = (column: FilterColumn) => string;
type Field = keyof EntryNarrowing;
type Term<K extends Field> = (
  value: NonNullable<EntryNarrowing[K]>,
  column: ColumnOf,
) => SqlFragment;

/** The least string above every string that starts with `prefix` in byte order, or null when
 * none is. */
export function prefixUpperBound(prefix: string): string | null {
  const points = Array.from(prefix);
  while (points.at(-1) === '\u{10FFFF}') points.pop();
  const last = points.pop();
  if (last === undefined) return null;
  const next = last.codePointAt(0)! + 1;
  return points.join('') + String.fromCodePoint(next === 0xd800 ? 0xe000 : next);
}

function inList(column: string, values: readonly string[]): SqlFragment {
  return values.length === 1
    ? { sql: `${column} = ?`, params: [values[0]!] }
    : { sql: `${column} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(values)] };
}

function startsWith(column: string, prefix: string): SqlFragment {
  const upper = prefixUpperBound(prefix);
  return upper === null
    ? { sql: `${column} >= ?`, params: [prefix] }
    : { sql: `${column} >= ? AND ${column} < ?`, params: [prefix, upper] };
}

type Terms = { readonly [K in Field]: Term<K> };

const TERMS: Terms = {
  ids: (ids, column) => inList(column('id'), ids),
  origins: (origins, column) => inList(column('origin_project'), origins),
  source: (source, column) => ({ sql: `${column('source')} = ?`, params: [source] }),
  sourcePrefix: (prefix, column) => startsWith(column('source'), prefix),
  artifactRefPrefix: (prefix, column) => startsWith(column('artifact_ref'), prefix),
  tag: (tag, column) => ({
    sql: `EXISTS (SELECT 1 FROM json_each(${tagsOf(column('tags_json'))}) WHERE value = ?)`,
    params: [tag],
  }),
  kinds: (kinds, column) => inList(`COALESCE(${column('kind')}, 'distilled')`, kinds),
  live: (_live, column) => ({ sql: notSupersededAt(column('superseded_by')), params: [] }),
  sessionId: (sessionId, column) => ({
    sql: `${column('source_session_id')} = ?`,
    params: [sessionId],
  }),
};

function term<K extends Field>(narrowing: EntryNarrowing, key: K, column: ColumnOf): SqlFragment[] {
  const value = narrowing[key];
  return value === undefined ? [] : [TERMS[key](value, column)];
}

/** The terms the fields of `narrowing` compile to, each ` AND ...`, empty when it sets none;
 * `column` names each field's column. */
export function narrowingAnd(
  narrowing: EntryNarrowing,
  column: ColumnOf = (name) => name,
): SqlFragment {
  // SAFETY: Object.keys lists TERMS' own keys, which are the keys of EntryNarrowing.
  const terms = (Object.keys(TERMS) as Field[]).flatMap((key) => term(narrowing, key, column));
  return {
    sql: terms.map((t) => ` AND ${t.sql}`).join(''),
    params: terms.flatMap((t) => t.params),
  };
}

/** A page of the rows `filter` keeps, in loadAllEntries' order or, with `page.newest`, newest
 * first. */
export function listEntriesWhere(
  db: DatabaseSyncLike,
  filter: EntryFilter,
  page: EntryPageRequest,
): EntryPage {
  const { tenantId, ...narrowing } = filter;
  const where = narrowingAnd(narrowing);
  if (narrowing.ids !== undefined) return idsPage(db, filter, where, page);
  const seeksSource = narrowing.sourcePrefix !== undefined && narrowing.origins === undefined;
  const index =
    seeksSource && tenantId !== ALL_TENANTS ? ' INDEXED BY idx_memories_source_tenant_created' : '';
  return entriesPage(
    tenantId,
    page,
    (within, limit) =>
      cachedStatement(
        db,
        `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories${index} WHERE ${within.match(`1${where.sql}`)} ${within.order}`,
      ).all(...where.params, ...within.params, limit) as MemoryRow[],
  );
}

function idsPage(
  db: DatabaseSyncLike,
  filter: EntryFilter,
  where: SqlFragment,
  page: EntryPageRequest,
): EntryPage {
  const tenant = tenantAnd(filter.tenantId, TENANT_IS);
  const range = entryRange(page.after, page.newest);
  const rows = cachedStatement(
    db,
    `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE 1${where.sql}${tenant.sql}${range.sql} ` +
      entryPageOrder(page.newest),
  ).all(...where.params, ...tenant.params, ...range.params, page.limit + 1) as MemoryRow[];
  const kept = keysetPage(rows, page.limit, (row): EntryCursor => ({
    created: row.created,
    id: row.id,
  }));
  return { entries: kept.rows.map(rowToEntry), next: kept.next };
}
