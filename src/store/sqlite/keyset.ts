// Keyset pages of memories: loadAllEntries' order, (created, id), read on the tenant-led index, and id order for a
// walk that needs each row once. No page sorts the table.
import type { DatabaseSyncLike } from '../../db/index.js';
import { keysetPage, type KeysetPage } from '../../base/util/keyset.js';
import { ALL_TENANTS, type TenantId } from '../../base/util/tenant.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { tenantAnd } from './tenant.js';
import type { EntryCursor } from '../port/types.js';
import type { IdPage } from '../port/embedding-index.js';

/** An ` AND ...` WHERE fragment, or empty, and the arguments it binds. */
export interface SqlAnd {
  readonly sql: string;
  readonly args: readonly string[];
}

/** What a page in loadAllEntries' order asks for. */
export interface EntryPageRequest {
  readonly limit: number;
  readonly after?: EntryCursor;
}

/** The tail every read in loadAllEntries' order ends with; its LIMIT binds the `limit` an EntryRowsRead is given. */
export const ENTRY_PAGE_ORDER = 'ORDER BY created ASC, id ASC LIMIT ?';

/** Up to `limit` of one tenant's rows in loadAllEntries' order: its WHERE appends `tenant` then `range`, and its SQL
 * ends with ENTRY_PAGE_ORDER. */
export type EntryRowsRead<R> = (tenant: SqlAnd, range: SqlAnd, limit: number) => R[];

/** Rows after `after`, up to `until` when set. The plain `created >=` is the range term SQLite seeks the index on;
 * the OR only settles ties on created. */
function entryRange(after: EntryCursor | undefined, until?: string): SqlAnd {
  const from = after
    ? { sql: ' AND created >= ? AND (created > ? OR id > ?)', args: [after.created, after.created, after.id] }
    : { sql: '', args: [] };
  return until === undefined ? from : { sql: `${from.sql} AND created <= ?`, args: [...from.args, until] };
}

const entryCursorOf = (row: EntryCursor): EntryCursor => ({ created: row.created, id: row.id });

/** The page of `read`'s rows after `page.after`, and where the next one starts; ALL_TENANTS merges the tenants. */
export function entryPage<R extends EntryCursor>(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  page: EntryPageRequest,
  read: EntryRowsRead<R>,
): KeysetPage<R, EntryCursor> {
  const keep = page.limit + 1;
  const rows =
    tenantId === ALL_TENANTS
      ? everyTenantRows(db, page.after, keep, read)
      : read(tenantAnd(tenantId), entryRange(page.after), keep);
  return keysetPage(rows, page.limit, entryCursorOf);
}

// No index orders memories by created across tenants, so each tenant is read on its own index and the reads merged.
function everyTenantRows<R extends EntryCursor>(
  db: DatabaseSyncLike,
  after: EntryCursor | undefined,
  keep: number,
  read: EntryRowsRead<R>,
): R[] {
  let rows: R[] = [];
  for (const tenantId of tenantIdsAt(db)) {
    // With a full page held, rows created after its last one cannot make the page, so later tenants read up to there.
    const until = rows.length === keep ? rows[keep - 1]!.created : undefined;
    const found = read(tenantAnd(tenantId), entryRange(after, until), keep);
    rows = rows.length === 0 ? found : [...rows, ...found].sort(byEntryOrder).slice(0, keep);
  }
  return rows;
}

// SQLite compares TEXT by its UTF-8 bytes; JS string order differs from that above U+FFFF.
const textOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function byEntryOrder(a: EntryCursor, b: EntryCursor): number {
  return textOrder(a.created, b.created) || textOrder(a.id, b.id);
}

// A loose index scan: one seek per tenant on idx_memories_tenant_created, not a read of every row.
const TENANT_IDS =
  'WITH RECURSIVE t(tenant_id) AS (SELECT MIN(tenant_id) FROM memories UNION ALL ' +
  'SELECT (SELECT MIN(tenant_id) FROM memories WHERE tenant_id > t.tenant_id) FROM t WHERE t.tenant_id IS NOT NULL) ' +
  'SELECT tenant_id FROM t WHERE tenant_id IS NOT NULL';

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface TenantIdRow {
  tenant_id: string;
}

function tenantIdsAt(db: DatabaseSyncLike): string[] {
  return (cachedStatement(db, TENANT_IDS).all() as TenantIdRow[]).map((row) => row.tenant_id);
}

/** The keyset clause that resumes id order after `afterId`; the primary key serves it, so the page sorts nothing. */
export function afterIdAnd(afterId: string | undefined): SqlAnd {
  return afterId === undefined ? { sql: '', args: [] } : { sql: ' AND id > ?', args: [afterId] };
}

/** The ids of a read in id order that fetched one row past `limit`, and the id the next page starts after. */
export function idPageOf(rows: ReadonlyArray<{ readonly id: string }>, limit: number): IdPage {
  const page = keysetPage(rows, limit, (row) => row.id);
  return { ids: page.rows.map((row) => row.id), next: page.next };
}
