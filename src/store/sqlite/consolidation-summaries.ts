// hippo.db's DAG summary reads and the one write that settles a dirty summary; what a summary settles to is decided in
// src/domain/consolidate/dag.ts.
import { DAG_LEVEL, type MemoryEntry } from '../../base/memory/entry.js';
import { type DatabaseSyncLike, withWriteScope } from '../../db/index.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import { readRejectedValue } from './rejection.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, parseJsonArray, rowToEntry } from './rows.js';
import { refusalAudit } from '../rules/audit-rows.js';
import { syncFtsRow } from './entry-row.js';
import { chunked } from '../../base/util/chunked.js';
import { keysetPage } from '../../base/util/keyset.js';
import { recordAuditEventsRowByRow } from './audit.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type {
  DirtySummaries,
  SummarySettle,
  SummarySettled,
} from '../../base/ports/store/consolidation.js';
import type { AppendAuditOptions, EntryCursor, EntryPage } from '../../base/ports/store/types.js';

/** One keyset page of the L2 topic summaries without an L3 parent, across all tenants; a SQL filter, since sleep's
 * survivors lack the L2s its own DAG pass just wrote. */
export function listL2SummariesPage(
  db: DatabaseSyncLike,
  page: { readonly limit: number; readonly after?: EntryCursor },
): EntryPage {
  const { after } = page;
  const range = after ? 'AND created >= ? AND (created > ? OR id > ?)' : '';
  const rows = cachedStatement(
    db,
    `
    SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories
     WHERE dag_level = ${DAG_LEVEL.topic}
       AND dag_parent_id IS NULL
       AND kind != 'archived'
       AND superseded_by IS NULL
       ${range}
     ORDER BY created ASC, id ASC
     LIMIT ?
  `,
  ).all(...(after ? [after.created, after.created, after.id] : []), page.limit + 1) as MemoryRow[];
  const kept = keysetPage(rows, page.limit, (row) => ({ created: row.created, id: row.id }));
  return { entries: kept.rows.map(rowToEntry), next: kept.next };
}

/** The `limit` dirty summaries of every tenant changed last (latest_at DESC NULLS LAST, id ASC), each with its live
 * children; one row past the limit tells whether more were waiting without reading the rest. */
export function dirtySummaries(db: DatabaseSyncLike, limit: number): DirtySummaries {
  const rows = cachedStatement(
    db,
    `
    SELECT ${MEMORY_SELECT_COLUMNS}
      FROM memories
     WHERE summary_dirty = 1
       AND kind != 'archived'
     ORDER BY latest_at DESC NULLS LAST, id ASC
     LIMIT ?
  `,
  ).all(limit + 1) as MemoryRow[];
  const summaries = rows.slice(0, limit).map(rowToEntry);
  const children = childrenOfSummaries(db, summaries);
  return {
    summaries: summaries.map((summary, i) => ({ summary, children: children[i]! })),
    more: rows.length > limit,
  };
}

/** The live children of each summary in one IN query per tenant chunk: one list per summary in the order given, each
 * by created then id; tenant-scoped as defence in depth. */
function childrenOfSummaries(
  db: DatabaseSyncLike,
  summaries: ReadonlyArray<{ id: string; tenantId: string }>,
): MemoryEntry[][] {
  const byTenant = new Map<string, string[]>();
  for (const s of summaries) {
    assertTenantId('loadChildrenOfSummaries', s.tenantId);
    const ids = byTenant.get(s.tenantId) ?? [];
    ids.push(s.id);
    byTenant.set(s.tenantId, ids);
  }
  const out = new Map<string, MemoryEntry[]>();
  for (const [tenantId, ids] of byTenant) {
    for (const slice of chunked(ids)) {
      const rows = cachedStatement(
        db,
        `
        SELECT ${MEMORY_SELECT_COLUMNS}
          FROM memories
         WHERE dag_parent_id IN (SELECT value FROM json_each(?))
           AND tenant_id = ?
           AND kind != 'archived'
           AND superseded_by IS NULL
         ORDER BY created ASC, id ASC
      `,
      ).all(JSON.stringify(slice), tenantId) as MemoryRow[];
      for (const entry of rows.map(rowToEntry)) {
        const key = childrenKey(tenantId, entry.dagParentId ?? '');
        const list = out.get(key);
        if (list) list.push(entry);
        else out.set(key, [entry]);
      }
    }
  }
  return summaries.map((summary) => out.get(childrenKey(summary.tenantId, summary.id)) ?? []);
}

function childrenKey(tenantId: string, summaryId: string): string {
  return `${tenantId}\u0000${summaryId}`;
}

// `summary_dirty = 1` makes a concurrent sleep's second write a no-op; RETURNING feeds the full-text row.
const STILL_DIRTY = `WHERE id = ?
              AND tenant_id = ?
              AND dag_level IN (${DAG_LEVEL.topic}, ${DAG_LEVEL.entity})
              AND summary_dirty = 1
              AND kind != 'archived'
            RETURNING content, tags_json`;
const SETTLE_CONTENT_SQL = `UPDATE memories
              SET content = ?,
                  descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  last_rebuilt_at = ?,
                  rebuild_count = COALESCE(rebuild_count, 0) + 1,
                  summary_dirty = 0
            ${STILL_DIRTY}`;
const SETTLE_FIELDS_SQL = `UPDATE memories
              SET descendant_count = ?,
                  earliest_at = ?,
                  latest_at = ?,
                  summary_dirty = 0
            ${STILL_DIRTY}`;
const SETTLE_CLEAN_SQL = `UPDATE memories SET summary_dirty = 0 ${STILL_DIRTY}`;

// SAFETY: every read cast to this row returns content and tags_json; scripts/check-row-casts.mjs proves it.
interface SettledRow {
  content: string;
  tags_json: string;
}

/** Lands the settle in one write scope when it carries fields, as a rebuild always has; a bare clean is one UPDATE. */
export function settleSummary(db: DatabaseSyncLike, settle: SummarySettle): SummarySettled {
  assertTenantId('settleSummary', settle.tenantId);
  return settle.fields
    ? withWriteScope(db, 'rebuild_summary', () => settleFields(db, settle, settle.fields!))
    : settleClean(db, settle);
}

function settleClean(db: DatabaseSyncLike, settle: SummarySettle): SummarySettled {
  const row = cachedStatement(db, SETTLE_CLEAN_SQL).get(settle.id, settle.tenantId) as
    | SettledRow
    | undefined;
  if (row) auditRows(db, settle.audit);
  return { changed: row !== undefined, refused: false };
}

function settleFields(
  db: DatabaseSyncLike,
  settle: SummarySettle,
  fields: NonNullable<SummarySettle['fields']>,
): SummarySettled {
  const { id, tenantId } = settle;
  const { content, descendantCount, earliestAt, latestAt } = fields;
  // This UPDATE bypasses the write guard, so the tombstone check runs here, inside the same transaction.
  const tombstone = content ? readRejectedValue(db, tenantId, rejectionDigest(content.text)) : null;
  const at = [descendantCount, earliestAt, latestAt] as const;
  const row =
    content && !tombstone
      ? (cachedStatement(db, SETTLE_CONTENT_SQL).get(
          content.text,
          ...at,
          content.rebuiltAt,
          id,
          tenantId,
        ) as SettledRow | undefined)
      : (cachedStatement(db, SETTLE_FIELDS_SQL).get(...at, id, tenantId) as SettledRow | undefined);
  if (!row) return { changed: false, refused: false };
  // A bare UPDATE leaves memories_fts behind, so the row's text is indexed again.
  syncFtsRow(db, { id, content: row.content, tags: parseJsonArray(row.tags_json) });
  const refusal = tombstone ? [refusalAudit(tenantId, settle.actor, id, tombstone)] : [];
  auditRows(db, [...refusal, ...settle.audit]);
  return { changed: true, refused: tombstone !== null };
}

/** Each row its own write, a failed one logged: an audit row never undoes the change it records. */
export function auditRows(db: DatabaseSyncLike, events: readonly AppendAuditOptions[]): number {
  const failed = recordAuditEventsRowByRow(db, events);
  for (const { event, error } of failed) reportAuditWriteFailure(event.op, error, event.targetId);
  return failed.length;
}
