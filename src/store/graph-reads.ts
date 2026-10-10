// The graph reads a view and a traversal share. Each opens hippo.db itself unless the caller hands it the handle its snapshot runs on.
import { openHippoDb, closeHippoDb, withReadSnapshot, type DatabaseSyncLike } from '../db/index.js';
import { onHandle } from './open.js';
import { assertTenantId } from './tenant.js';
import {
  type EntityType,
  GRAPH_ENTITY_TYPES,
  type Entity,
  type Relation,
  type EntityRow,
  type RelationRow,
  type StoredEntity,
  type StoredGraph,
  type StoredRelation,
  rowToEntity,
  rowToRelation,
  ENTITY_COLS,
  RELATION_COLS
} from './graph-rows.js';

const DEFAULT_GRAPH_PAGE_SIZE = 100;
const DEFAULT_GRAPH_SCAN_LIMIT = 1000;

/** Entities with an exact `name` (read), bounded by `limit` in SQL with a
 *  deterministic order. Lets the graph-view focus query find the `--entity NAME`
 *  entity DIRECTLY (not from a globally-capped list) WITHOUT materializing every
 *  same-name row when a name maps to many entities. */
export function loadEntitiesByName(
  hippoRoot: string,
  tenantId: string,
  name: string,
  opts: { limit?: number } = {},
  txDb?: DatabaseSyncLike,
): Entity[] {
  assertTenantId('loadEntitiesByName', tenantId);
  const limit = opts.limit ?? DEFAULT_GRAPH_PAGE_SIZE;
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
  txDb?: DatabaseSyncLike,
): Entity[] {
  assertTenantId('loadEntities', tenantId);
  const limit = opts.limit ?? DEFAULT_GRAPH_PAGE_SIZE;
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
  txDb?: DatabaseSyncLike,
): Relation[] {
  assertTenantId('loadRelations', tenantId);
  const limit = opts.limit ?? DEFAULT_GRAPH_PAGE_SIZE;
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

/** Chunk size for IN-list queries: well under SQLite's 999-bound-variable default
 *  (leaves headroom for the tenant_id param + the doubled list in neighbour lookups). */
export const IN_LIST_CHUNK = 400;

/**
 * Load entities by their primary ids. Resolves the entity rows reached during the BFS
 * (whose `memory_id` maps back to a recall result). Tenant-scoped, read-only.
 */
export function loadEntitiesByIds(
  hippoRoot: string,
  tenantId: string,
  ids: number[],
  txDb?: DatabaseSyncLike,
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
 * All relations touching ANY of `entityIds` in EITHER direction (from OR to): the
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
  txDb?: DatabaseSyncLike,
): Relation[] {
  assertTenantId('loadNeighborRelations', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? DEFAULT_GRAPH_SCAN_LIMIT;
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
 * intra-union edges: no out-of-union row can evict a valid in-set edge. The
 * caller bounds `entityIds` (<= the view limit), so a single query is safe.
 */
export function loadRelationsAmong(
  hippoRoot: string,
  tenantId: string,
  entityIds: number[],
  opts: { limit?: number } = {},
  txDb?: DatabaseSyncLike,
): Relation[] {
  assertTenantId('loadRelationsAmong', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? DEFAULT_GRAPH_SCAN_LIMIT;
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
  return onHandle(hippoRoot, (db) => {
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
  });
}

/** The stored rows a rebuild diffs against, read on the caller's handle so the diff and the apply can share one write lock. */
export function storedGraphOn(db: DatabaseSyncLike, tenantId: string, memoryIds: readonly string[]): StoredGraph {
  const kinds = memoryKindsOn(db, memoryIds);
  // SAFETY: the SELECT names exactly the columns of StoredEntity.
  const entities = db.prepare(
    `SELECT id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id FROM entities WHERE tenant_id = ? ORDER BY id`,
  ).all(tenantId) as StoredEntity[];
  // SAFETY: the SELECT names exactly the columns of StoredRelation.
  const relations = db.prepare(
    `SELECT id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, source_object_type, source_object_id FROM relations WHERE tenant_id = ? ORDER BY id`,
  ).all(tenantId) as StoredRelation[];
  return { kinds, entities, relations };
}

function memoryKindsOn(db: DatabaseSyncLike, memoryIds: readonly string[]): ReadonlyMap<string, string> {
  if (memoryIds.length === 0) return new Map();
  // SAFETY: the SELECT names exactly the two columns of the row type.
  const rows = db.prepare(`SELECT id, kind FROM memories WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(memoryIds)) as Array<{ id: string; kind: string }>;
  return new Map(rows.map((row) => [row.id, row.kind]));
}

/** storedGraphOn on its own connection, outside any write lock. */
export function loadStoredGraph(hippoRoot: string, tenantId: string, memoryIds: readonly string[]): StoredGraph {
  return onHandle(hippoRoot, (db) => {
    return storedGraphOn(db, tenantId, memoryIds);
  });
}

/**
 * Run `fn` inside ONE read transaction (a single WAL snapshot) so every graph read
 * it performs (pass the supplied `txDb` to the `load*` functions) sees a consistent
 * view, even if a `graph extract` / sleep-drain rebuild commits concurrently between
 * reads (the rebuild clears + reinserts entities, so separate reads could otherwise
 * mix old entity ids with new relation ids). Reads only; the connection is opened
 * once and closed after.
 */
export function withGraphReadSnapshot<T>(
  hippoRoot: string,
  fn: (txDb: DatabaseSyncLike) => T,
): T {
  return onHandle(hippoRoot, (db) => {
    return withReadSnapshot(db, () => fn(db));
  });
}
