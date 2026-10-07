import { openHippoDb, closeHippoDb } from '../db.js';
import { assertTenantId } from '../tenant.js';
import { type GraphTxDb, type EntityType, type GraphQueueStatus, GRAPH_ENTITY_TYPES, VALID_QUEUE_STATES, type Entity, type Relation, type GraphQueueItem } from './types.js';
import { type EntityRow, type RelationRow, type QueueRow, rowToEntity, rowToRelation, rowToQueueItem, ENTITY_COLS, RELATION_COLS, QUEUE_COLS } from './rows.js';

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

/** Entities with an exact `name` (read), bounded by `limit` in SQL with a
 *  deterministic order. Lets the graph-view focus query find the `--entity NAME`
 *  entity DIRECTLY (not from a globally-capped list) WITHOUT materializing every
 *  same-name row when a name maps to many entities. */
export function loadEntitiesByName(
  hippoRoot: string,
  tenantId: string,
  name: string,
  opts: { limit?: number } = {},
  txDb?: GraphTxDb,
): Entity[] {
  assertTenantId('loadEntitiesByName', tenantId);
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadEntitiesByName: limit must be a non-negative integer; got ${limit}`);
  }
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    // SAFETY: rows' shape matches the columns named in ENTITY_COLS above.
    const rows = db.prepare(`
      SELECT ${ENTITY_COLS} FROM entities WHERE tenant_id = ? AND name = ?
      ORDER BY id ASC LIMIT ?
    `).all(tenantId, name, limit) as EntityRow[];
    return rows.map(rowToEntity);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

export function loadEntities(
  hippoRoot: string,
  tenantId: string,
  opts: { entityType?: EntityType; limit?: number } = {},
  txDb?: GraphTxDb,
): Entity[] {
  assertTenantId('loadEntities', tenantId);
  const limit = opts.limit ?? 100;
  if (opts.entityType && !GRAPH_ENTITY_TYPES.has(opts.entityType)) {
    throw new Error(`loadEntities: entityType must be one of ${Array.from(GRAPH_ENTITY_TYPES).join('|')}; got ${opts.entityType}`);
  }
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (opts.entityType) {
      clauses.push('entity_type = ?');
      params.push(opts.entityType);
    }
    params.push(limit);
    // SAFETY: rows' shape matches the columns named in ENTITY_COLS above.
    const rows = db.prepare(`
      SELECT ${ENTITY_COLS} FROM entities
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as EntityRow[];
    return rows.map(rowToEntity);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

export function loadRelations(
  hippoRoot: string,
  tenantId: string,
  opts: { fromEntityId?: number; limit?: number } = {},
  txDb?: GraphTxDb,
): Relation[] {
  assertTenantId('loadRelations', tenantId);
  const limit = opts.limit ?? 100;
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const clauses = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (opts.fromEntityId !== undefined) {
      clauses.push('from_entity_id = ?');
      params.push(opts.fromEntityId);
    }
    params.push(limit);
    // SAFETY: rows' shape matches the columns named in RELATION_COLS above.
    const rows = db.prepare(`
      SELECT ${RELATION_COLS} FROM relations
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params) as RelationRow[];
    return rows.map(rowToRelation);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

// ---------------------------------------------------------------------------
// Multi-hop recall read helpers (SELECT-only; the check-graph-writes lint
// permits these here and in the read-only consumer src/graph-recall.ts).
// ---------------------------------------------------------------------------

/** Chunk size for IN-list queries: well under SQLite's 999-bound-variable default
 *  (leaves headroom for the tenant_id param + the doubled list in neighbour lookups). */
const IN_LIST_CHUNK = 400;

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

/**
 * Load entities by their primary ids. Resolves the entity rows reached during the BFS
 * (whose `memory_id` maps back to a recall result). Tenant-scoped, read-only.
 */
export function loadEntitiesByIds(
  hippoRoot: string,
  tenantId: string,
  ids: number[],
  txDb?: GraphTxDb,
): Entity[] {
  assertTenantId('loadEntitiesByIds', tenantId);
  if (ids.length === 0) return [];
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const out: Entity[] = [];
    for (let i = 0; i < ids.length; i += IN_LIST_CHUNK) {
      const slice = ids.slice(i, i + IN_LIST_CHUNK);
      const ph = slice.map(() => '?').join(',');
      // SAFETY: rows' shape matches the columns named in ENTITY_COLS above.
      const rows = db.prepare(`
        SELECT ${ENTITY_COLS} FROM entities
        WHERE tenant_id = ? AND id IN (${ph})
      `).all(tenantId, ...slice) as EntityRow[];
      out.push(...rows.map(rowToEntity));
    }
    return out;
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

/**
 * All relations touching ANY of `entityIds` in EITHER direction (from OR to) — the
 * per-hop neighbour query for multi-hop traversal. ONE query for the whole frontier
 * (not one per node): this is the bidirectional read `loadRelations` (from-only) lacks,
 * and avoids an N+1 across BFS frontier nodes. `limit` caps rows for the frontier and
 * must be a non-negative integer (the raw `LIMIT ?` rejects a fractional value).
 */
export function loadNeighborRelations(
  hippoRoot: string,
  tenantId: string,
  entityIds: number[],
  opts: { limit?: number } = {},
  txDb?: GraphTxDb,
): Relation[] {
  assertTenantId('loadNeighborRelations', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadNeighborRelations: limit must be a non-negative integer; got ${limit}`);
  }
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    // `limit` is applied PER CHUNK; a frontier spanning >IN_LIST_CHUNK ids could return
    // up to limit*chunks rows before the by-id dedup below. Harmless for multi-hop recall (the
    // frontier is bounded by maxNeighbors <= 200 << IN_LIST_CHUNK, so a single chunk,
    // and the BFS re-enforces the per-hop fanout cap), but note the semantics if a
    // tighter total cap is ever needed.
    const byId = new Map<number, Relation>();
    for (let i = 0; i < entityIds.length; i += IN_LIST_CHUNK) {
      const slice = entityIds.slice(i, i + IN_LIST_CHUNK);
      const ph = slice.map(() => '?').join(',');
      // SAFETY: rows' shape matches the columns named in RELATION_COLS above.
      const rows = db.prepare(`
        SELECT ${RELATION_COLS} FROM relations
        WHERE tenant_id = ? AND (from_entity_id IN (${ph}) OR to_entity_id IN (${ph}))
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(tenantId, ...slice, ...slice, limit) as RelationRow[];
      for (const r of rows) byId.set(r.id, rowToRelation(r));
    }
    return Array.from(byId.values());
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

/**
 * Relations with BOTH endpoints in `entityIds` (edges AMONG the set, not merely
 * touching it). Read. Used by the graph-view focus subgraph so the displayed
 * edges are exactly the intra-union edges: the `LIMIT` only caps genuinely-many
 * intra-union edges — no out-of-union row can evict a valid in-set edge. The
 * caller bounds `entityIds` (<= the view limit), so a single query is safe.
 */
export function loadRelationsAmong(
  hippoRoot: string,
  tenantId: string,
  entityIds: number[],
  opts: { limit?: number } = {},
  txDb?: GraphTxDb,
): Relation[] {
  assertTenantId('loadRelationsAmong', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadRelationsAmong: limit must be a non-negative integer; got ${limit}`);
  }
  const ownDb = txDb ? null : openHippoDb(hippoRoot);
  const db = txDb ?? ownDb!;
  try {
    const ph = entityIds.map(() => '?').join(',');
    // SAFETY: rows' shape matches the columns named in RELATION_COLS above.
    const rows = db.prepare(`
      SELECT ${RELATION_COLS} FROM relations
      WHERE tenant_id = ? AND from_entity_id IN (${ph}) AND to_entity_id IN (${ph})
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(tenantId, ...entityIds, ...entityIds, limit) as RelationRow[];
    return rows.map(rowToRelation);
  } finally {
    if (ownDb) closeHippoDb(ownDb);
  }
}

/**
 * Run `fn` inside ONE read transaction (a single WAL snapshot) so every graph read
 * it performs — pass the supplied `txDb` to the `load*` functions — sees a consistent
 * view, even if a `graph extract` / sleep-drain rebuild commits concurrently between
 * reads (the rebuild clears + reinserts entities, so separate reads could otherwise
 * mix old entity ids with new relation ids). Reads only; the connection is opened
 * once and closed after.
 */
export function withGraphReadSnapshot<T>(
  hippoRoot: string,
  fn: (txDb: GraphTxDb) => T,
): T {
  const db = openHippoDb(hippoRoot);
  try {
    db.exec('BEGIN');
    try {
      const out = fn(db);
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
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
