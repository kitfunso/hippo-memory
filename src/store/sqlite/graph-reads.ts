// hippo.db's GraphReads group: one read snapshot around the CLI's graph walks, and the rows a view or a traversal reads
// on the handle that snapshot runs on.
import { DEFAULT_LIST_LIMIT } from '../../util/limits.js';
import { withReadSnapshot, type DatabaseSyncLike } from '../../db/index.js';
import { assertTenantId } from '../../core/tenant-id.js';
import {
  GRAPH_ENTITY_TYPES,
  type EntityRow,
  type RelationRow,
  rowToEntity,
  rowToRelation,
  ENTITY_COLS,
  RELATION_COLS,
} from './graph-rows.js';
import {
  GRAPH_ID_BATCH,
  type EntityType,
  type Entity,
  type Relation,
  type StoredEntity,
  type StoredGraph,
  type StoredRelation,
} from '../port/graph-reads.js';
import { chunked } from '../../util/chunked.js';
import { placeholders } from '../../util/sql.js';
import type { GraphRows, GraphReads, GraphViewQuery } from '../port.js';
import type { Sync } from './served.js';
import { canReadScope } from '../../core/recall-scope.js';
import type { OnHandle } from './open.js';
import { bound, type Bodies } from './bound.js';

const DEFAULT_GRAPH_PAGE_SIZE = DEFAULT_LIST_LIMIT;
const DEFAULT_GRAPH_SCAN_LIMIT = 1000;

/** Entities with an exact `name`, bounded by `limit` in SQL with a deterministic order, so graph-view focus finds
 * `--entity NAME` directly without materializing every same-name row. */
function loadEntitiesByNameAt(
  db: DatabaseSyncLike,
  tenantId: string,
  name: string,
  opts: { limit?: number } = {},
): Entity[] {
  assertTenantId('loadEntitiesByName', tenantId);
  const limit = opts.limit ?? DEFAULT_GRAPH_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadEntitiesByName: limit must be a non-negative integer; got ${limit}`);
  }
  const rows = db
    .prepare(`
    SELECT ${ENTITY_COLS} FROM entities WHERE tenant_id = ? AND name = ?
    ORDER BY id ASC LIMIT ?
  `)
    .all(tenantId, name, limit) as EntityRow[];
  return rows.map(rowToEntity);
}

export function loadEntitiesAt(
  db: DatabaseSyncLike,
  tenantId: string,
  opts: { entityType?: EntityType; limit?: number } = {},
): Entity[] {
  assertTenantId('loadEntities', tenantId);
  const limit = opts.limit ?? DEFAULT_GRAPH_PAGE_SIZE;
  if (opts.entityType && !GRAPH_ENTITY_TYPES.has(opts.entityType)) {
    throw new Error(
      `loadEntities: entityType must be one of ${Array.from(GRAPH_ENTITY_TYPES).join('|')}; got ${opts.entityType}`,
    );
  }
  const clauses = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];
  if (opts.entityType) {
    clauses.push('entity_type = ?');
    params.push(opts.entityType);
  }
  params.push(limit);
  const rows = db
    .prepare(`
    SELECT ${ENTITY_COLS} FROM entities
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
    .all(...params) as EntityRow[];
  return rows.map(rowToEntity);
}

export function loadRelationsAt(
  db: DatabaseSyncLike,
  tenantId: string,
  opts: { fromEntityId?: number; limit?: number } = {},
): Relation[] {
  assertTenantId('loadRelations', tenantId);
  const limit = opts.limit ?? DEFAULT_GRAPH_PAGE_SIZE;
  const clauses = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];
  if (opts.fromEntityId !== undefined) {
    clauses.push('from_entity_id = ?');
    params.push(opts.fromEntityId);
  }
  params.push(limit);
  const rows = db
    .prepare(`
    SELECT ${RELATION_COLS} FROM relations
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
    .all(...params) as RelationRow[];
  return rows.map(rowToRelation);
}

/** Load entities by primary id (the BFS-reached rows whose `memory_id` maps back to a recall result). Tenant-scoped,
 * read-only. */
function loadEntitiesByIdsAt(db: DatabaseSyncLike, tenantId: string, ids: readonly number[]): Entity[] {
  assertTenantId('loadEntitiesByIds', tenantId);
  if (ids.length === 0) return [];
  const out: Entity[] = [];
  for (const slice of chunked(ids, GRAPH_ID_BATCH)) {
    const ph = placeholders(slice.length);
    const rows = db
      .prepare(`
      SELECT ${ENTITY_COLS} FROM entities
      WHERE tenant_id = ? AND id IN (${ph})
    `)
      .all(tenantId, ...slice) as EntityRow[];
    out.push(...rows.map(rowToEntity));
  }
  return out;
}

/** All relations touching ANY of `entityIds` in EITHER direction: the per-hop neighbor query for multi-hop traversal,
 * one query for the whole frontier (no N+1). `limit` caps rows and must be a non-negative integer (raw `LIMIT ?`
 * rejects a fraction). */
function loadNeighborRelationsAt(
  db: DatabaseSyncLike,
  tenantId: string,
  entityIds: readonly number[],
  opts: { limit?: number } = {},
): Relation[] {
  assertTenantId('loadNeighborRelations', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? DEFAULT_GRAPH_SCAN_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadNeighborRelations: limit must be a non-negative integer; got ${limit}`);
  }
  // `limit` applies PER CHUNK, so a frontier over one chunk of ids could return limit*chunks rows before the dedup
  // below; harmless today (frontier <= maxNeighbors 200, one chunk, BFS re-enforces the fanout cap).
  const byId = new Map<number, Relation>();
  for (const slice of chunked(entityIds, GRAPH_ID_BATCH)) {
    const ph = placeholders(slice.length);
    const rows = db
      .prepare(`
      SELECT ${RELATION_COLS} FROM relations
      WHERE tenant_id = ? AND (from_entity_id IN (${ph}) OR to_entity_id IN (${ph}))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
      .all(tenantId, ...slice, ...slice, limit) as RelationRow[];
    for (const r of rows) byId.set(r.id, rowToRelation(r));
  }
  return Array.from(byId.values());
}

/** Relations with BOTH endpoints in `entityIds` (edges AMONG the set), for the graph-view focus subgraph; `LIMIT` caps
 * only intra-union edges, so no out-of-union row evicts a valid one. The caller bounds `entityIds` (<= view limit), so
 * a single query is safe. */
function loadRelationsAmongAt(
  db: DatabaseSyncLike,
  tenantId: string,
  entityIds: number[],
  opts: { limit?: number } = {},
): Relation[] {
  assertTenantId('loadRelationsAmong', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? DEFAULT_GRAPH_SCAN_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`loadRelationsAmong: limit must be a non-negative integer; got ${limit}`);
  }
  const ph = placeholders(entityIds.length);
  const rows = db
    .prepare(`
    SELECT ${RELATION_COLS} FROM relations
    WHERE tenant_id = ? AND from_entity_id IN (${ph}) AND to_entity_id IN (${ph})
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `)
    .all(tenantId, ...entityIds, ...entityIds, limit) as RelationRow[];
  return rows.map(rowToRelation);
}

/** Map consolidated source memory ids to their graph entities: the SEED step of multi-hop recall. Tenant-scoped,
 * read-only; chunks the IN-list under the SQLite variable cap. */
function loadEntitiesByMemoryIdAt(db: DatabaseSyncLike, tenantId: string, memoryIds: readonly string[]): Entity[] {
  assertTenantId('loadEntitiesByMemoryId', tenantId);
  if (memoryIds.length === 0) return [];
  const out: Entity[] = [];
  for (const slice of chunked(memoryIds, GRAPH_ID_BATCH)) {
    const ph = placeholders(slice.length);
    // id ASC so chunk-local scan order never decides ties (id is an autoincrement PK).
    const rows = db
      .prepare(`
      SELECT ${ENTITY_COLS} FROM entities
      WHERE tenant_id = ? AND memory_id IN (${ph})
      ORDER BY id ASC
    `)
      .all(tenantId, ...slice) as EntityRow[];
    out.push(...rows.map(rowToEntity));
  }
  return out;
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type StoredEntityDbRow = StoredEntity;

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
type StoredRelationDbRow = StoredRelation;

/** The stored rows a rebuild diffs against, read on the caller's handle so the diff and the apply can share one write
 * lock. */
export function storedGraphOn(db: DatabaseSyncLike, tenantId: string, memoryIds: readonly string[]): StoredGraph {
  const kinds = memoryKindsOn(db, memoryIds);
  const entities = db
    .prepare(
      `SELECT id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id FROM entities ` +
        `WHERE tenant_id = ? ORDER BY id`,
    )
    .all(tenantId) as StoredEntityDbRow[];
  const relations = db
    .prepare(
      `SELECT id, from_entity_id, to_entity_id, rel_type, memory_id, ` +
        `source_kind, source_object_type, source_object_id ` +
        `FROM relations WHERE tenant_id = ? ORDER BY id`,
    )
    .all(tenantId) as StoredRelationDbRow[];
  return { kinds, entities, relations };
}

function memoryKindsOn(db: DatabaseSyncLike, memoryIds: readonly string[]): ReadonlyMap<string, string> {
  if (memoryIds.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT id, kind FROM memories WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(memoryIds)) as Array<{ id: string; kind: string }>;
  return new Map(rows.map((row) => [row.id, row.kind]));
}

/** storedGraphOn on its own connection, outside any write lock. */
/** Run `fn` in ONE read transaction (a single WAL snapshot) so every `load*` read via `txDb` sees a consistent view
 * even if a rebuild commits concurrently (it clears and reinserts entities, so separate reads could mix old entity ids
 * with new relation ids). */
function withGraphReadSnapshotAt<T>(db: DatabaseSyncLike, fn: (txDb: DatabaseSyncLike) => T): T {
  return withReadSnapshot(db, () => fn(db));
}

type CanRead = (scope: string | null) => boolean;

interface GraphViewSpec {
  readonly entity?: string;
  readonly limit: number;
  readonly canRead?: CanRead;
}

/** `db` is the handle the caller's snapshot is open on, which every read here must use. */
interface GraphSource {
  readonly db: DatabaseSyncLike;
  readonly tenantId: string;
}

/** The items whose source memory `canRead` admits: a NULL memoryId has no scope to hide, and a missing memory fails
 * closed. */
function readableOnly<T extends { memoryId: string | null }>(
  db: DatabaseSyncLike,
  tenantId: string,
  items: T[],
  canRead: CanRead | undefined,
): T[] {
  if (!canRead) return items;
  const ids = [...new Set(items.flatMap((i) => (i.memoryId === null ? [] : [i.memoryId])))];
  const readable = new Set<string>();
  for (const slice of chunked(ids, GRAPH_ID_BATCH)) {
    const rows = db
      .prepare(`SELECT id, scope FROM memories WHERE +tenant_id = ? AND id IN (${placeholders(slice.length)})`)
      .all(tenantId, ...slice) as Array<{ id: string; scope: string | null }>;
    for (const r of rows) if (canRead(r.scope)) readable.add(r.id);
  }
  return items.filter((i) => i.memoryId === null || readable.has(i.memoryId));
}

function wholeGraphRows({ db, tenantId }: GraphSource, limit: number): GraphRows {
  const entities = loadEntitiesAt(db, tenantId, { limit });
  const relations = loadRelationsAt(db, tenantId, { limit });
  return { entities, relations, truncated: entities.length >= limit || relations.length >= limit };
}

/** The named entities with their 1-hop neighbors and the edges among that union; null when the caller may read none of
 * the named ones. */
function focusRows(
  { db, tenantId }: GraphSource,
  name: string,
  limit: number,
  canRead: CanRead | undefined,
): GraphRows | null {
  // The name is queried directly, so it is found on a graph larger than `limit`; one name can map to many entities, so
  // the matches are capped.
  const named = loadEntitiesByNameAt(db, tenantId, name, { limit });
  // A hidden focus must not answer through its neighbors that the name exists.
  const focus = readableOnly(db, tenantId, named, canRead);
  if (focus.length === 0) return null;
  const focusIds = focus.map((e) => e.id);
  const hop = loadNeighborRelationsAt(db, tenantId, focusIds, { limit });
  const union = new Set<number>(focusIds);
  let neighborsCapped = false;
  for (const r of hop) {
    if (union.size >= limit) {
      neighborsCapped = true; // node cap filled before all neighbors were added
      break;
    }
    union.add(r.fromEntityId);
    union.add(r.toEntityId);
  }
  const unionIds = [...union].slice(0, limit);
  const entities = loadEntitiesByIdsAt(db, tenantId, unionIds);
  // Both endpoints in the set: neighbor-to-neighbor edges are included, and the LIMIT never drops one for an
  // out-of-union row.
  const relations = loadRelationsAmongAt(db, tenantId, unionIds, { limit });
  const truncated =
    named.length >= limit ||
    hop.length >= limit || // neighbor scan capped -> a 1-hop neighbor may be omitted
    neighborsCapped || // node cap filled before all neighbors were consumed
    union.size > unionIds.length ||
    relations.length >= limit;
  return { entities, relations, truncated };
}

/** What `GraphReads.graphRows` answers, read on `db`: the caller opens the one snapshot that keeps entity ids and
 * relation ids from two different rebuilds apart. */
function graphViewRows(db: DatabaseSyncLike, tenantId: string, spec: GraphViewSpec): GraphRows {
  const source = { db, tenantId };
  const raw =
    spec.entity !== undefined
      ? focusRows(source, spec.entity, spec.limit, spec.canRead)
      : wholeGraphRows(source, spec.limit);
  if (raw === null) return { entities: [], relations: [], truncated: false };
  return {
    entities: readableOnly(db, tenantId, raw.entities, spec.canRead),
    relations: readableOnly(db, tenantId, raw.relations, spec.canRead),
    truncated: raw.truncated,
  };
}

function graphRowsAt(db: DatabaseSyncLike, tenantId: string, { entity, limit, reader }: GraphViewQuery): GraphRows {
  return withGraphReadSnapshotAt(db, (snapshot) =>
    graphViewRows(snapshot, tenantId, {
      entity,
      limit,
      canRead: reader && ((scope) => scope === null || canReadScope(reader, scope)),
    }),
  );
}

const graphReadsAt: Bodies<GraphReads> = {
  graphRows: graphRowsAt,
  entitiesForMemories: loadEntitiesByMemoryIdAt,
  entitiesByIds: loadEntitiesByIdsAt,
  neighborRelations: loadNeighborRelationsAt,
  storedGraph: storedGraphOn,
};

export function sqliteGraphReads(on: OnHandle): Sync<GraphReads> {
  return bound(on, graphReadsAt);
}
