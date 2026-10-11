// The graph reads a view and a traversal share. Each opens hippo.db itself unless the caller hands it the handle its snapshot runs on.
import { DEFAULT_LIST_LIMIT } from '../util/limits.js';
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

const DEFAULT_GRAPH_PAGE_SIZE = DEFAULT_LIST_LIMIT;
const DEFAULT_GRAPH_SCAN_LIMIT = 1000;

/** Entities with an exact `name`, bounded by `limit` in SQL with a deterministic order, so graph-view focus finds `--entity NAME` directly
 * without materializing every same-name row. */
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

/** Load entities by primary id (the BFS-reached rows whose `memory_id` maps back to a recall result). Tenant-scoped, read-only. */
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

/** All relations touching ANY of `entityIds` in EITHER direction: the per-hop neighbour query for multi-hop traversal, one query for the whole frontier
 * (no N+1). `limit` caps rows and must be a non-negative integer (raw `LIMIT ?` rejects a fraction). */
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
    // `limit` applies PER CHUNK, so a frontier over IN_LIST_CHUNK ids could return limit*chunks rows before the dedup below;
    // harmless today (frontier <= maxNeighbors 200, one chunk, BFS re-enforces the fanout cap).
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

/** Relations with BOTH endpoints in `entityIds` (edges AMONG the set), for the graph-view focus subgraph; `LIMIT` caps only intra-union edges,
 * so no out-of-union row evicts a valid one. The caller bounds `entityIds` (<= view limit), so a single query is safe. */
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

/** Map consolidated source memory ids to their graph entities: the SEED step of multi-hop recall. Tenant-scoped, read-only; chunks the IN-list under the
 * SQLite variable cap. */
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

/** Run `fn` in ONE read transaction (a single WAL snapshot) so every `load*` read via `txDb` sees a consistent view
 * even if a rebuild commits concurrently (it clears and reinserts entities, so separate reads could mix old entity ids with new relation ids). */
export function withGraphReadSnapshot<T>(
  hippoRoot: string,
  fn: (txDb: DatabaseSyncLike) => T,
): T {
  return onHandle(hippoRoot, (db) => {
    return withReadSnapshot(db, () => fn(db));
  });
}
