import { DEFAULT_LIST_LIMIT } from '../../../base/util/limits.js';
import { withReadSnapshot, type DatabaseSyncLike } from '../../../db/index.js';
import { assertTenantId } from '../../../base/scope/tenant-id.js';
import {
  type EntityRow,
  type RelationRow,
  rowToEntity,
  rowToRelation,
  ENTITY_COLS,
  RELATION_COLS,
} from './graph-rows.js';
import { GRAPH_ID_BATCH, type Entity, type Relation } from '../../../base/ports/store/graph.js';
import { chunked } from '../../../base/util/chunked.js';
import type {
  GraphRows,
  GraphReads,
  GraphViewQuery,
  GraphWalkQuery,
} from '../../../base/ports/store.js';
import { canReadScope } from '../../../base/scope/recall-scope.js';
import type { OnHandle } from '../runtime/open.js';
import { bound, type Bodies } from '../runtime/bound.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { graphDeltaOn } from './graph-delta.js';

const DEFAULT_GRAPH_PAGE_SIZE = DEFAULT_LIST_LIMIT;
const DEFAULT_GRAPH_SCAN_LIMIT = 1000;

function listEntitiesByName(
  db: DatabaseSyncLike,
  tenantId: string,
  name: string,
  opts: { limit?: number } = {},
): Entity[] {
  assertTenantId('listEntitiesByName', tenantId);
  const limit = opts.limit ?? DEFAULT_GRAPH_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`listEntitiesByName: limit must be a non-negative integer; got ${limit}`);
  }
  const rows = cachedStatement(
    db,
    `
    SELECT ${ENTITY_COLS} FROM entities WHERE tenant_id = ? AND name = ?
    ORDER BY id ASC LIMIT ?
  `,
  ).all(tenantId, name, limit) as EntityRow[];
  return rows.map(rowToEntity);
}

function listEntities(db: DatabaseSyncLike, tenantId: string, limit: number): Entity[] {
  assertTenantId('listEntities', tenantId);
  const rows = cachedStatement(
    db,
    `SELECT ${ENTITY_COLS} FROM entities WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(tenantId, limit) as EntityRow[];
  return rows.map(rowToEntity);
}

function listRelations(db: DatabaseSyncLike, tenantId: string, limit: number): Relation[] {
  assertTenantId('listRelations', tenantId);
  const rows = cachedStatement(
    db,
    `SELECT ${RELATION_COLS} FROM relations WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(tenantId, limit) as RelationRow[];
  return rows.map(rowToRelation);
}

function readEntitiesByIds(
  db: DatabaseSyncLike,
  tenantId: string,
  ids: readonly number[],
): Entity[] {
  assertTenantId('readEntitiesByIds', tenantId);
  if (ids.length === 0) return [];
  const out: Entity[] = [];
  for (const slice of chunked(ids, GRAPH_ID_BATCH)) {
    const rows = cachedStatement(
      db,
      `
      SELECT ${ENTITY_COLS} FROM entities
      WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))
    `,
    ).all(tenantId, JSON.stringify(slice)) as EntityRow[];
    out.push(...rows.map(rowToEntity));
  }
  return out;
}

function neighborRowsOf(
  db: DatabaseSyncLike,
  tenantId: string,
  slice: readonly number[],
  limit: number,
): RelationRow[] {
  const ids = JSON.stringify(slice);
  return cachedStatement(
    db,
    `
      SELECT ${RELATION_COLS} FROM relations
      WHERE tenant_id = ?
        AND (from_entity_id IN (SELECT value FROM json_each(?)) OR to_entity_id IN (SELECT value FROM json_each(?)))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
  ).all(tenantId, ids, ids, limit) as RelationRow[];
}

function newestFirst(a: RelationRow, b: RelationRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return b.id - a.id;
}

function listNeighborRelations(
  db: DatabaseSyncLike,
  tenantId: string,
  entityIds: readonly number[],
  opts: { limit?: number } = {},
): Relation[] {
  assertTenantId('listNeighborRelations', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? DEFAULT_GRAPH_SCAN_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`listNeighborRelations: limit must be a non-negative integer; got ${limit}`);
  }
  const byId = new Map<number, RelationRow>();
  for (const slice of chunked(entityIds, GRAPH_ID_BATCH)) {
    for (const r of neighborRowsOf(db, tenantId, slice, limit)) byId.set(r.id, r);
  }
  const merged = Array.from(byId.values());
  if (merged.length > limit) merged.sort(newestFirst).length = limit;
  return merged.map(rowToRelation);
}

function listRelationsAmong(
  db: DatabaseSyncLike,
  tenantId: string,
  entityIds: number[],
  opts: { limit?: number } = {},
): Relation[] {
  assertTenantId('listRelationsAmong', tenantId);
  if (entityIds.length === 0) return [];
  const limit = opts.limit ?? DEFAULT_GRAPH_SCAN_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`listRelationsAmong: limit must be a non-negative integer; got ${limit}`);
  }
  const ids = JSON.stringify(entityIds);
  const rows = cachedStatement(
    db,
    `
    SELECT ${RELATION_COLS} FROM relations
    WHERE tenant_id = ? AND from_entity_id IN (SELECT value FROM json_each(?))
      AND to_entity_id IN (SELECT value FROM json_each(?))
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `,
  ).all(tenantId, ids, ids, limit) as RelationRow[];
  return rows.map(rowToRelation);
}

function listEntitiesByMemoryId(
  db: DatabaseSyncLike,
  tenantId: string,
  memoryIds: readonly string[],
): Entity[] {
  assertTenantId('listEntitiesByMemoryId', tenantId);
  if (memoryIds.length === 0) return [];
  const out: Entity[] = [];
  for (const slice of chunked(memoryIds, GRAPH_ID_BATCH)) {
    const rows = cachedStatement(
      db,
      `
      SELECT ${ENTITY_COLS} FROM entities
      WHERE tenant_id = ? AND memory_id IN (SELECT value FROM json_each(?))
      ORDER BY id ASC
    `,
    ).all(tenantId, JSON.stringify(slice)) as EntityRow[];
    out.push(...rows.map(rowToEntity));
  }
  return out;
}

function withGraphReadSnapshot<T>(db: DatabaseSyncLike, fn: (txDb: DatabaseSyncLike) => T): T {
  return withReadSnapshot(db, () => fn(db));
}

type CanRead = (scope: string | null) => boolean;

interface GraphViewSpec {
  readonly entity?: string;
  readonly limit: number;
  readonly canRead?: CanRead;
}

interface GraphSource {
  readonly db: DatabaseSyncLike;
  readonly tenantId: string;
}

function readableOnly<T extends { memoryId: string | null; sourceObjectId?: number }>(
  db: DatabaseSyncLike,
  tenantId: string,
  items: T[],
  canRead: CanRead | undefined,
): T[] {
  if (!canRead) return items;
  const ids = [...new Set(items.flatMap((i) => (i.memoryId === null ? [] : [i.memoryId])))];
  const readable = new Set<string>();
  for (const slice of chunked(ids, GRAPH_ID_BATCH)) {
    const rows = cachedStatement(
      db,
      `SELECT id, scope FROM memories WHERE +tenant_id = ? AND id IN (SELECT value FROM json_each(?))`,
    ).all(tenantId, JSON.stringify(slice)) as Array<{ id: string; scope: string | null }>;
    for (const r of rows) if (canRead(r.scope)) readable.add(r.id);
  }
  return items.filter((i) =>
    i.memoryId === null ? i.sourceObjectId !== undefined : readable.has(i.memoryId),
  );
}

function wholeGraphRows({ db, tenantId }: GraphSource, limit: number): GraphRows {
  const entities = listEntities(db, tenantId, limit);
  const relations = listRelations(db, tenantId, limit);
  return { entities, relations, truncated: entities.length >= limit || relations.length >= limit };
}

function focusRows(
  { db, tenantId }: GraphSource,
  name: string,
  limit: number,
  canRead: CanRead | undefined,
): GraphRows | null {
  const named = listEntitiesByName(db, tenantId, name, { limit });
  const focus = readableOnly(db, tenantId, named, canRead);
  if (focus.length === 0) return null;
  const focusIds = focus.map((e) => e.id);
  const hop = listNeighborRelations(db, tenantId, focusIds, { limit });
  const union = new Set<number>(focusIds);
  let neighborsCapped = false;
  for (const r of hop) {
    if (union.size >= limit) {
      neighborsCapped = true;
      break;
    }
    union.add(r.fromEntityId);
    union.add(r.toEntityId);
  }
  const unionIds = [...union].slice(0, limit);
  const entities = readEntitiesByIds(db, tenantId, unionIds);
  const relations = listRelationsAmong(db, tenantId, unionIds, { limit });
  const truncated =
    named.length >= limit ||
    hop.length >= limit ||
    neighborsCapped ||
    union.size > unionIds.length ||
    relations.length >= limit;
  return { entities, relations, truncated };
}

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

function viewRows(
  db: DatabaseSyncLike,
  tenantId: string,
  { entity, limit, reader }: GraphViewQuery,
): GraphRows {
  return withGraphReadSnapshot(db, (snapshot) =>
    graphViewRows(snapshot, tenantId, {
      entity,
      limit,
      canRead: reader && ((scope) => scope === null || canReadScope(reader, scope)),
    }),
  );
}

function walkRows(db: DatabaseSyncLike, tenantId: string, query: GraphWalkQuery): GraphRows {
  const only = (entities: Entity[], relations: Relation[] = []): GraphRows => ({
    entities,
    relations,
    truncated: false,
  });
  if (query.by === 'memory') return only(listEntitiesByMemoryId(db, tenantId, query.ids));
  if (query.by === 'entity') return only(readEntitiesByIds(db, tenantId, query.ids));
  return only([], listNeighborRelations(db, tenantId, query.ids, { limit: query.limit }));
}

const graphReadsBodies: Bodies<GraphReads> = {
  graphRows: (db, tenantId, query) =>
    'by' in query ? walkRows(db, tenantId, query) : viewRows(db, tenantId, query),
  graphDelta: graphDeltaOn,
};

export function sqliteGraphReads(on: OnHandle): GraphReads {
  return bound(on, graphReadsBodies);
}
