// Keyset pages of memories: loadAllEntries' order, (created, id), read on the tenant-led index, and id order for a
// walk that needs each row once. No page sorts the table.
import { keysetPage, type KeysetPage } from '../../base/util/keyset.js';
import { ALL_TENANTS, type TenantId } from '../../base/util/tenant.js';
import { tenantAnd } from './tenant.js';
import type { SqlFragment } from '../../db/sql.js';
import { orderSql, STORE_ORDER } from '../rules/order.js';
import type { EntryCursor } from '../port/types.js';
import type { IdPage } from '../port/vectors.js';

/** What a page in loadAllEntries' order asks for; `newest` walks that order backwards, newest row first. */
export interface EntryPageRequest {
  readonly limit: number;
  readonly after?: EntryCursor;
  readonly newest?: boolean;
}

/** The tail every read in loadAllEntries' order ends with; its LIMIT binds the `limit` an EntryRowsRead is given. */
export const ENTRY_PAGE_ORDER = `ORDER BY ${orderSql(STORE_ORDER)} LIMIT ?`;
const NEWEST_PAGE_ORDER = `ORDER BY ${orderSql(STORE_ORDER.map((key) => ({ ...key, desc: true })))} LIMIT ?`;

/** Where one page in loadAllEntries' order reads: `match(filter)` is the WHERE that keeps the rows `filter` keeps of
 * the page's tenant, or of every tenant, after its cursor, and `params` binds what it adds, after the filter's own.
 * `order` is the page's ORDER BY and LIMIT tail, ENTRY_PAGE_ORDER unless the page walks newest first. */
export interface EntryRows {
  readonly match: (filter: string) => string;
  readonly params: readonly (string | number)[];
  readonly order: string;
}

/** Up to `limit` rows in loadAllEntries' order: its SQL is `SELECT ... FROM memories WHERE ${rows.match(filter)}`
 * then `rows.order`, and it binds the filter's arguments, then `rows.params`, then `limit`. */
export type EntryRowsRead<R> = (rows: EntryRows, limit: number) => R[];

/** Rows past `after` in the page's direction. The plain `created` bound is the range term SQLite seeks the index on;
 * the OR only settles ties on created. */
export function entryRange(after: EntryCursor | undefined, newest = false): SqlFragment {
  if (!after) return { sql: '', params: [] };
  const params = [after.created, after.created, after.id];
  return newest
    ? { sql: ' AND created <= ? AND (created < ? OR id < ?)', params }
    : { sql: ' AND created >= ? AND (created > ? OR id > ?)', params };
}

/** The ORDER BY and LIMIT tail of a page that walks oldest or newest first. */
export const entryPageOrder = (newest = false): string => (newest ? NEWEST_PAGE_ORDER : ENTRY_PAGE_ORDER);

const entryCursorOf = (row: EntryCursor): EntryCursor => ({ created: row.created, id: row.id });

/** The page of `read`'s rows after `page.after`, and where the next one starts; ALL_TENANTS reads every tenant in one
 * statement. */
export function entryPage<R extends EntryCursor>(
  tenantId: TenantId,
  page: EntryPageRequest,
  read: EntryRowsRead<R>,
): KeysetPage<R, EntryCursor> {
  const keep = page.limit + 1;
  const range = entryRange(page.after, page.newest);
  const order = entryPageOrder(page.newest);
  const rows =
    tenantId === ALL_TENANTS ? everyTenantRows(range, keep, order) : oneTenantRows(tenantAnd(tenantId), range, order);
  return keysetPage(read(rows, keep), page.limit, entryCursorOf);
}

function oneTenantRows(tenant: SqlFragment, range: SqlFragment, order: string): EntryRows {
  return {
    match: (filter) => `(${filter})${tenant.sql}${range.sql}`,
    params: [...tenant.params, ...range.params],
    order,
  };
}

// No index orders memories by created across tenants, so each tenant's first `keep` rows come off its own index, one
// seek per tenant in a loose scan, and the statement sorts only those. INDEXED BY: a filter the origin index covers
// would otherwise sort the whole tenant.
function everyTenantRows(range: SqlFragment, keep: number, order: string): EntryRows {
  return {
    match: (filter) =>
      `rowid IN (${TENANT_IDS} SELECT m.rowid FROM t JOIN memories m ON m.rowid IN (SELECT rowid FROM memories ` +
      `INDEXED BY idx_memories_tenant_created WHERE tenant_id = t.tid AND (${filter})${range.sql} ${order}))`,
    params: [...range.params, keep],
    order,
  };
}

const TENANT_IDS =
  'WITH RECURSIVE t(tid) AS (SELECT MIN(tenant_id) FROM memories UNION ALL ' +
  'SELECT (SELECT MIN(tenant_id) FROM memories WHERE tenant_id > t.tid) FROM t WHERE t.tid IS NOT NULL)';

/** The keyset clause that resumes id order after `afterId`; the primary key serves it, so the page sorts nothing. */
export function afterIdAnd(afterId: string | undefined): SqlFragment {
  return afterId === undefined ? { sql: '', params: [] } : { sql: ' AND id > ?', params: [afterId] };
}

/** The ids of a read in id order that fetched one row past `limit`, and the id the next page starts after. */
export function idPageOf(rows: ReadonlyArray<{ readonly id: string }>, limit: number): IdPage {
  const page = keysetPage(rows, limit, (row) => row.id);
  return { ids: page.rows.map((row) => row.id), next: page.next };
}
