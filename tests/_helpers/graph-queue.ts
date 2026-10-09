// Reads graph_extraction_queue rows off a real store; production only drains the queue, so no src reader exists.
import { openHippoDb, closeHippoDb } from '../../src/db.js';
import { QUEUE_COLS, rowToQueueItem, type GraphQueueItem, type GraphQueueStatus, type QueueRow } from '../../src/store/graph-rows.js';

export function loadExtractionQueue(
  hippoRoot: string,
  tenantId: string,
  opts: { status?: GraphQueueStatus; limit?: number } = {},
): GraphQueueItem[] {
  const db = openHippoDb(hippoRoot);
  try {
    const status = opts.status === undefined ? '' : ' AND status = ?';
    const params = [tenantId, ...(opts.status === undefined ? [] : [opts.status]), opts.limit ?? 100];
    // SAFETY: the SELECT names exactly QUEUE_COLS, matching QueueRow.
    const rows = db.prepare(
      `SELECT ${QUEUE_COLS} FROM graph_extraction_queue WHERE tenant_id = ?${status} ORDER BY enqueued_at ASC, id ASC LIMIT ?`,
    ).all(...params) as QueueRow[];
    return rows.map(rowToQueueItem);
  } finally {
    closeHippoDb(db);
  }
}
