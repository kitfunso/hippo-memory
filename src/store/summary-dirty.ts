// Leaf module so store.ts and raw-archive.ts can both mark a parent summary dirty without importing each other.
import { appendAuditEvent, reportAuditWriteFailure } from './audit.js';
import type { DatabaseSyncLike } from '../db/index.js';

/** Runs in the caller's transaction so the mark commits or rolls back with the child change; only a 0 to 1 flip is audited. */
export function markSummaryDirtyInTx(
  db: DatabaseSyncLike,
  summaryId: string,
  tenantId: string,
  actor: string,
): void {
  // SAFETY: result's shape matches the single `dag_level` column returned below.
  const result = db.prepare(`
    UPDATE memories
       SET summary_dirty = 1
     WHERE id = ?
       AND tenant_id = ?
       AND dag_level IN (2, 3)
       AND summary_dirty = 0
       AND kind != 'archived'
    RETURNING dag_level
  `).get(summaryId, tenantId) as { dag_level: number } | undefined;
  if (!result) return;
  try {
    appendAuditEvent(db, {
      tenantId,
      actor,
      op: 'summary_marked_dirty',
      targetId: summaryId,
      metadata: { dag_level: result.dag_level, source: 'E2' },
    });
  } catch (error) {
    // The mark has already succeeded; a broken audit table must not undo it.
    reportAuditWriteFailure('summary_marked_dirty', String(error), summaryId);
  }
}
