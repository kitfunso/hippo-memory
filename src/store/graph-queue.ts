// The graph extraction queue: the consolidated memories that wait for a graph rebuild, and the watermark the sleep drain marks them by.
import { openHippoDb, closeHippoDb } from '../db.js';
import { assertTenantId } from '../tenant.js';
import { errorMessage, log } from '../log.js';
import { type GraphQueueItem, type QueueRow, rowToQueueItem, QUEUE_COLS } from './graph-rows.js';
import { resolveConsolidatedSource } from './graph-writes.js';

/**
 * Enqueue a consolidated memory for later graph extraction. Rejects a raw / missing /
 * cross-tenant memory (the DB trigger is the backstop).
 */
function enqueueExtraction(
  hippoRoot: string,
  tenantId: string,
  memoryId: string,
): GraphQueueItem {
  assertTenantId('enqueueExtraction', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    // enqueue is memory-keyed (no source object), so a missing memory still throws (correct -
    // you cannot enqueue a forgotten mirror); memoryId is non-null here by construction.
    const { sourceKind } = resolveConsolidatedSource(db, tenantId, memoryId, null, 'enqueueExtraction');
    const result = db.prepare(`
      INSERT INTO graph_extraction_queue(tenant_id, memory_id, kind, status, enqueued_at, processed_at)
      VALUES (?, ?, ?, 'pending', ?, NULL)
    `).run(tenantId, memoryId, sourceKind, now);
    const id = Number(result.lastInsertRowid ?? 0);
    // SAFETY: row's shape matches the columns named in QUEUE_COLS above.
    const row = db.prepare(`SELECT ${QUEUE_COLS} FROM graph_extraction_queue WHERE id = ?`).get(id) as QueueRow | undefined;
    if (!row) throw new Error('enqueueExtraction: failed to reload queue item');
    return rowToQueueItem(row);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * Fail-soft producer hook: mark a tenant dirty for graph re-extraction by
 * enqueuing its consolidated mirror memory. NEVER throws into the caller — a
 * graph-dirty signal failing must not abort a core object write. Graph staleness is
 * recoverable (next sleep / manual `graph extract`); a broken `hippo decide` is
 * not. Called POST-COMMIT from the graph-source save/close mutations of
 * decision, policy, customer_note and project_brief. A null memoryId (a
 * forgotten mirror) is a no-op.
 */
export function markGraphDirty(hippoRoot: string, tenantId: string, memoryId: string | null): void {
  if (!memoryId) return;
  try {
    enqueueExtraction(hippoRoot, tenantId, memoryId);
  } catch (err) {
    // Logged (warn) so a SYSTEMATIC enqueue failure surfaces to operators, but
    // swallowed so the already-committed object write is never rolled back.
    log.warn(
      `markGraphDirty: enqueue failed for tenant=${tenantId} memory=${memoryId}: ${errorMessage(err)}`,
    );
  }
}

/**
 * Mark every pending queue item for a tenant with `id <= maxId` processed, in
 * one UPDATE. Status/processed_at only, so the consolidated-source guard trigger
 * is not involved. Returns the count marked.
 * The `<= maxId` watermark excludes items enqueued after the drain snapshot.
 */
export function markPendingProcessedUpTo(
  hippoRoot: string,
  tenantId: string,
  maxId: number,
): number {
  assertTenantId('markPendingProcessedUpTo', tenantId);
  const now = new Date().toISOString();
  const db = openHippoDb(hippoRoot);
  try {
    const res = db.prepare(`
      UPDATE graph_extraction_queue
      SET status = 'processed', processed_at = ?
      WHERE tenant_id = ? AND status = 'pending' AND id <= ?
    `).run(now, tenantId, maxId);
    return Number(res.changes ?? 0);
  } finally {
    closeHippoDb(db);
  }
}

/**
 * The dirty tenants awaiting graph re-extraction, each with the MAX pending
 * queue id at read time (a watermark). The sleep drain rebuilds each tenant's
 * graph, then marks only items at or below the watermark processed, so items
 * enqueued DURING the rebuild stay pending for the next sleep (no lost-update
 * race). Host-wide read (the queue is per-tenant but sleep is cross-tenant).
 */
export function loadPendingExtractionTenants(
  hippoRoot: string,
): { tenantId: string; maxPendingId: number }[] {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: rows' shape matches the two aliased columns (tenant_id, max_id)
    // named in the SELECT above.
    const rows = db.prepare(`
      SELECT tenant_id AS tenant_id, MAX(id) AS max_id
      FROM graph_extraction_queue
      WHERE status = 'pending'
      GROUP BY tenant_id
    `).all() as { tenant_id: string; max_id: number }[];
    return rows.map((r) => ({ tenantId: r.tenant_id, maxPendingId: Number(r.max_id) }));
  } finally {
    closeHippoDb(db);
  }
}
