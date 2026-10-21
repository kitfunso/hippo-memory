// Leaf module so entry-writes.ts and raw-archive.ts can both mark a parent summary dirty without importing each other.
import { appendAuditEvent } from './audit.js';
import { reportAuditWriteFailure } from '../../base/records/audit-report.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import { DAG_LEVEL } from '../../base/memory/memory.js';
import type { AppendAuditOpts } from '../port/types.js';
import { cachedStatement } from '../../db/statement-cache.js';

const MARK_DIRTY_WHERE = `tenant_id = ?
       AND dag_level IN (${DAG_LEVEL.topic}, ${DAG_LEVEL.entity})
       AND summary_dirty = 0
       AND kind != 'archived'`;

/** The audit row for a summary whose dirty flag flipped from 0 to 1. */
export function summaryDirtyAuditRow(
  summaryId: string,
  tenantId: string,
  actor: string,
  dagLevel: number,
): AppendAuditOpts {
  const metadata = { dag_level: dagLevel, source: 'E2' };
  return { tenantId, actor, op: 'summary_marked_dirty', targetId: summaryId, metadata };
}

/** Runs in the caller's transaction so the mark commits or rolls back with the child change; only a 0 to 1 flip is
 * audited. */
export function markSummaryDirtyInTx(db: DatabaseSyncLike, summaryId: string, tenantId: string, actor: string): void {
  const result = cachedStatement(
    db,
    `
    UPDATE memories
       SET summary_dirty = 1
     WHERE id = ?
       AND ${MARK_DIRTY_WHERE}
    RETURNING dag_level
  `,
  ).get(summaryId, tenantId) as { dag_level: number } | undefined;
  if (!result) return;
  try {
    appendAuditEvent(db, summaryDirtyAuditRow(summaryId, tenantId, actor, result.dag_level));
  } catch (error) {
    // The mark has already succeeded; a broken audit table must not undo it.
    reportAuditWriteFailure('summary_marked_dirty', error, summaryId);
  }
}

/** markSummaryDirtyInTx's flip for many summaries of one tenant in one statement, with no audit rows: the caller writes
 * them in its own order. Returns the dag_level of each summary that flipped. */
export function markSummariesDirtyInTx(
  db: DatabaseSyncLike,
  summaryIds: readonly string[],
  tenantId: string,
): Map<string, number> {
  if (summaryIds.length === 0) return new Map();
  const flipped = cachedStatement(
    db,
    `
    UPDATE memories
       SET summary_dirty = 1
     WHERE id IN (SELECT value FROM json_each(?))
       AND ${MARK_DIRTY_WHERE}
    RETURNING id, dag_level
  `,
  ).all(JSON.stringify(summaryIds), tenantId) as Array<{ id: string; dag_level: number }>;
  return new Map(flipped.map((row) => [row.id, row.dag_level]));
}
