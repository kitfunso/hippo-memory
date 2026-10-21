// The in-memory GraphReads group: the entity and relation walks hippo.db runs, in its id batches and orders.
import { canReadScope } from '../../base/scope/recall-scope.js';
import {
  GRAPH_ID_BATCH,
  type Entity,
  type GraphReads,
  type GraphRows,
  type GraphViewQuery,
  type Relation,
  type StoredGraph,
} from '../port/graph.js';
import { newestFirst } from '../rules/order.js';
import type { MemoryTables } from './tables.js';

const newestCreated = newestFirst<{ createdAt: string; id: number }>({ key: (r) => r.createdAt, intId: (r) => r.id });
const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;

function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += GRAPH_ID_BATCH) out.push(items.slice(i, i + GRAPH_ID_BATCH));
  return out;
}

/** The relations touching the start ids, each batch's newest `limit`, without repeats. */
function joinedFrom(relations: readonly Relation[], startIds: readonly number[], limit: number): Relation[] {
  const joined: Relation[] = [];
  for (const batch of batches(startIds)) {
    const touching = relations
      .filter((r) => batch.includes(r.fromEntityId) || batch.includes(r.toEntityId))
      .sort(newestCreated)
      .slice(0, limit);
    for (const r of touching) if (!joined.includes(r)) joined.push(r);
  }
  return joined;
}

/** The walk from a name, before any row is hidden; null when no start entity shows. */
function fromName(
  graph: { readonly entities: Entity[]; readonly relations: Relation[] },
  name: string,
  limit: number,
  shows: (row: Entity) => boolean,
): GraphRows | null {
  const named = graph.entities
    .filter((e) => e.name === name)
    .sort(byId)
    .slice(0, limit);
  const startIds = named.filter(shows).map((e) => e.id);
  if (startIds.length === 0) return null;
  const joined = joinedFrom(graph.relations, startIds, limit);
  const held = new Set(startIds);
  let leftOver = false;
  for (const r of joined) {
    if (held.size >= limit) {
      leftOver = true;
      break;
    }
    held.add(r.fromEntityId).add(r.toEntityId);
  }
  const found = batches([...held]).flatMap((batch) => graph.entities.filter((e) => batch.includes(e.id)).sort(byId));
  const among = graph.relations
    .filter((r) => held.has(r.fromEntityId) && held.has(r.toEntityId))
    .sort(newestCreated)
    .slice(0, limit);
  const truncated = named.length >= limit || joined.length >= limit || among.length >= limit || leftOver;
  return { entities: found, relations: among, truncated };
}

function wholeGraph(entities: Entity[], relations: Relation[], limit: number): GraphRows {
  const newest = {
    entities: [...entities].sort(newestCreated).slice(0, limit),
    relations: [...relations].sort(newestCreated).slice(0, limit),
  };
  return { ...newest, truncated: newest.entities.length >= limit || newest.relations.length >= limit };
}

function graphRowsIn(t: MemoryTables, tenantId: string, { entity, limit, reader }: GraphViewQuery): GraphRows {
  const shows = (row: { memoryId: string | null }): boolean => {
    if (row.memoryId === null || !reader) return true;
    const memory = t.entries.get(row.memoryId);
    if (!memory || memory.tenantId !== tenantId) return false;
    return memory.scope === null || canReadScope(reader, memory.scope);
  };
  const entities = t.entities.filter((e) => e.tenantId === tenantId);
  const relations = t.relations.filter((r) => r.tenantId === tenantId);
  const rows =
    entity === undefined
      ? wholeGraph(entities, relations, limit)
      : fromName({ entities, relations }, entity, limit, shows);
  if (!rows) return { entities: [], relations: [], truncated: false };
  const visible = { entities: rows.entities.filter(shows), relations: rows.relations.filter(shows) };
  return structuredClone({ ...visible, truncated: rows.truncated });
}

/** The provenance columns a rebuild diffs, as hippo.db names them. */
const sourceColumns = (row: Entity | Relation) => ({
  memory_id: row.memoryId,
  source_kind: row.sourceKind,
  source_object_type: row.sourceObjectType ?? null,
  source_object_id: row.sourceObjectId ?? null,
});

function storedGraphIn(t: MemoryTables, tenantId: string, memoryIds: readonly string[]): StoredGraph {
  const kinds = memoryIds.flatMap((id): [string, string][] => {
    const memory = t.entries.get(id);
    return memory ? [[id, memory.kind]] : [];
  });
  const entities = t.entities.filter((e) => e.tenantId === tenantId).sort(byId);
  const relations = t.relations.filter((r) => r.tenantId === tenantId).sort(byId);
  return structuredClone({
    kinds: new Map(kinds),
    entities: entities.map((e) => ({ id: e.id, entity_type: e.entityType, name: e.name, ...sourceColumns(e) })),
    relations: relations.map((r) => ({
      id: r.id,
      from_entity_id: r.fromEntityId,
      to_entity_id: r.toEntityId,
      rel_type: r.relType,
      ...sourceColumns(r),
    })),
  });
}

function entitiesWhere<K>(t: MemoryTables, keys: readonly K[], holds: (e: Entity, batch: K[]) => boolean): Entity[] {
  return structuredClone(batches(keys).flatMap((batch) => t.entities.filter((e) => holds(e, batch)).sort(byId)));
}

export function memoryGraphReads(t: MemoryTables): GraphReads {
  return {
    graphRows: async (tenantId, query) => graphRowsIn(t, tenantId, query),
    entitiesForMemories: async (tenantId, memoryIds) =>
      entitiesWhere(
        t,
        memoryIds,
        (e, batch) => e.tenantId === tenantId && e.memoryId !== null && batch.includes(e.memoryId),
      ),
    entitiesByIds: async (tenantId, ids) =>
      entitiesWhere(t, ids, (e, batch) => e.tenantId === tenantId && batch.includes(e.id)),
    async neighborRelations(tenantId, entityIds, { limit }) {
      const found = new Map<number, Relation>();
      for (const batch of batches(entityIds)) {
        const touching = t.relations.filter(
          (r) => r.tenantId === tenantId && (batch.includes(r.fromEntityId) || batch.includes(r.toEntityId)),
        );
        for (const r of touching.sort(newestCreated).slice(0, limit)) found.set(r.id, r);
      }
      return structuredClone([...found.values()]);
    },
    storedGraph: async (tenantId, memoryIds) => storedGraphIn(t, tenantId, memoryIds),
  };
}
