import { openHippoDb, closeHippoDb } from '../db.js';
import { assertTenantId } from '../tenant.js';
import { type GraphQueueStatus, VALID_QUEUE_STATES, type Entity, type GraphQueueItem } from './types.js';
import { type QueueRow, rowToQueueItem, QUEUE_COLS } from './rows.js';
import { IN_LIST_CHUNK } from '../store/graph-reads.js';
import { type EntityRow, rowToEntity, ENTITY_COLS } from '../store/graph-rows.js';

// The SQL of these sits in the store; graph code and its tests still read through this module.
export { loadEntities, loadEntitiesByIds, loadNeighborRelations, loadRelations, loadRelationsAmong } from '../store/graph-reads.js';

export function loadEntityById(hippoRoot: string, tenantId: string, id: number): Entity | null {
  assertTenantId('loadEntityById', tenantId);
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: row's shape matches the columns named in ENTITY_COLS above.
    const row = db.prepare(`SELECT ${ENTITY_COLS} FROM entities WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// Multi-hop recall read helpers (SELECT-only; the check-graph-writes lint
// permits these here and in the read-only consumer src/graph-recall.ts).
// ---------------------------------------------------------------------------

/**
 * Map consolidated source memory ids -> their graph entities. The SEED step of
 * multi-hop recall (recall result memory ids -> entities to traverse from). Tenant-
 * scoped, read-only; chunks the IN-list under the SQLite variable cap.
 */
export function loadEntitiesByMemoryId(
  hippoRoot: string,
  tenantId: string,
  memoryIds: string[],
): Entity[] {
  assertTenantId('loadEntitiesByMemoryId', tenantId);
  if (memoryIds.length === 0) return [];
  const db = openHippoDb(hippoRoot);
  try {
    const out: Entity[] = [];
    for (let i = 0; i < memoryIds.length; i += IN_LIST_CHUNK) {
      const slice = memoryIds.slice(i, i + IN_LIST_CHUNK);
      const ph = slice.map(() => '?').join(',');
      // id ASC so chunk-local scan order never decides ties (id is an autoincrement PK).
      // SAFETY: rows' shape matches the columns named in ENTITY_COLS above.
      const rows = db.prepare(`
        SELECT ${ENTITY_COLS} FROM entities
        WHERE tenant_id = ? AND memory_id IN (${ph})
        ORDER BY id ASC
      `).all(tenantId, ...slice) as EntityRow[];
      out.push(...rows.map(rowToEntity));
    }
    return out;
  } finally {
    closeHippoDb(db);
  }
}

export function loadExtractionQueue(
  hippoRoot: string,
  tenantId: string,
  opts: { status?: GraphQueueStatus; limit?: number } = {},
): GraphQueueItem[] {
  assertTenantId('loadExtractionQueue', tenantId);
  const limit = opts.limit ?? 100;
  if (opts.status && !VALID_QUEUE_STATES.has(opts.status)) {
    throw new Error(`loadExtractionQueue: status must be one of ${Array.from(VALID_QUEUE_STATES).join('|')}; got ${opts.status}`);
  }
  const db = openHippoDb(hippoRoot);
  try {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    params.push(limit);
    // SAFETY: rows' shape matches the columns named in QUEUE_COLS above.
    const rows = db.prepare(`
      SELECT ${QUEUE_COLS} FROM graph_extraction_queue
      WHERE ${clauses.join(' AND ')}
      ORDER BY enqueued_at ASC, id ASC
      LIMIT ?
    `).all(...params) as QueueRow[];
    return rows.map(rowToQueueItem);
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
