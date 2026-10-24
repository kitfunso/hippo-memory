// The graph rebuild's diff: the ops that turn the stored rows into the derived graph, so a rebuild writes only what
// changed and an entity keeps the id its relations hang on. hippo.db runs the same rule in SQL (sqlite/graph-delta.ts).
import type { DesiredEntity, DesiredGraph, DesiredRelation, GraphOp, NaturalKey } from '../port/graph.js';

/** The entity columns a rebuild diffs against. */
export interface StoredEntity {
  id: number;
  entity_type: string;
  name: string;
  memory_id: string | null;
  source_kind: string;
  source_object_type: string | null;
  source_object_id: number | null;
}

/** The relation columns a rebuild diffs against. */
export interface StoredRelation {
  id: number;
  from_entity_id: number;
  to_entity_id: number;
  rel_type: string;
  memory_id: string | null;
  source_kind: string;
  source_object_type: string | null;
  source_object_id: number | null;
}

/** One tenant's stored graph as a rebuild reads it, with the kind of each memory the desired rows name. */
export interface StoredGraph {
  readonly kinds: ReadonlyMap<string, string>;
  readonly entities: readonly StoredEntity[];
  readonly relations: readonly StoredRelation[];
}

const keyText = (entityType: string, objectType: string, objectId: number): string =>
  `${entityType}|${objectType}:${objectId}`;

export function entityKey(k: NaturalKey): string {
  return keyText(k.entityType, k.sourceObject.type, k.sourceObject.id);
}

function storedKey(row: StoredEntity): string | null {
  if (row.source_object_type === null || row.source_object_id === null) return null;
  return keyText(row.entity_type, row.source_object_type, row.source_object_id);
}

export const relationKey = (from: string, to: string, relType: string): string => `${from}>${to}|${relType}`;

/** Memory id to kind, so a desired row's source_kind is known before the write resolves it the same way. */
export type MemoryKinds = ReadonlyMap<string, string>;

/** The (memory, kind) pair a write would store: a missing mirror leaves the object path, which is 'distilled'. */
export function provenanceOf(memoryId: string | null, kinds: MemoryKinds): string {
  const kind = memoryId === null ? undefined : kinds.get(memoryId);
  return kind === undefined ? '|distilled' : `${memoryId}|${kind}`;
}

export function memoryIdsOf(desired: DesiredGraph): string[] {
  const ids = new Set<string>();
  for (const row of [...desired.entities, ...desired.relations]) if (row.memoryId !== null) ids.add(row.memoryId);
  return [...ids];
}

function firstByKey<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!out.has(key)) out.set(key, row);
  }
  return out;
}

interface EntityDelta {
  ops: GraphOp[];
  /** Entity id to key for each stored row that survives the diff; relations are matched through it. */
  keptKeyById: Map<number, string>;
}

/** The desired entities, the first of each natural key, in desired order. */
export const wantedEntities = (desired: DesiredGraph): Map<string, DesiredEntity> =>
  firstByKey(desired.entities, entityKey);

/** The desired relations, the first of each (from, to, type) key, in desired order. */
export const wantedRelations = (desired: DesiredGraph): Map<string, DesiredRelation> =>
  firstByKey(desired.relations, (r) => relationKey(entityKey(r.from), entityKey(r.to), r.relType));

function diffEntities(
  stored: readonly StoredEntity[],
  wanted: ReadonlyMap<string, DesiredEntity>,
  kinds: MemoryKinds,
): EntityDelta {
  const kept = new Map<string, StoredEntity>();
  const deletes: GraphOp[] = [];
  for (const row of stored) {
    const key = storedKey(row);
    if (key === null || kept.has(key) || !wanted.has(key)) deletes.push({ op: 'deleteEntity', id: row.id });
    else kept.set(key, row);
  }
  const updates: GraphOp[] = [];
  const inserts: GraphOp[] = [];
  for (const [key, entity] of wanted) {
    const row = kept.get(key);
    if (!row) inserts.push({ op: 'insertEntity', entity });
    else if (
      row.name !== entity.name ||
      `${row.memory_id ?? ''}|${row.source_kind}` !== provenanceOf(entity.memoryId, kinds)
    ) {
      updates.push({ op: 'updateEntity', id: row.id, entity });
    }
  }
  const keptKeyById = new Map([...kept].map(([key, row]) => [row.id, key]));
  return { ops: [...deletes, ...updates, ...inserts], keptKeyById };
}

function diffRelations(
  stored: readonly StoredRelation[],
  wanted: ReadonlyMap<string, DesiredRelation>,
  keptKeyById: ReadonlyMap<number, string>,
  kinds: MemoryKinds,
): GraphOp[] {
  const kept = new Set<string>();
  const deletes: GraphOp[] = [];
  for (const row of stored) {
    const from = keptKeyById.get(row.from_entity_id);
    const to = keptKeyById.get(row.to_entity_id);
    // An edge on a deleted entity goes with it through the v38 cascade.
    if (from === undefined || to === undefined) continue;
    const key = relationKey(from, to, row.rel_type);
    const want = wanted.get(key);
    const same =
      want !== undefined &&
      !kept.has(key) &&
      `${row.memory_id ?? ''}|${row.source_kind}` === provenanceOf(want.memoryId, kinds) &&
      row.source_object_type === want.sourceObject.type &&
      row.source_object_id === want.sourceObject.id;
    if (same) kept.add(key);
    else deletes.push({ op: 'deleteRelation', id: row.id });
  }
  const inserts: GraphOp[] = [];
  for (const [key, relation] of wanted) if (!kept.has(key)) inserts.push({ op: 'insertRelation', relation });
  return [...deletes, ...inserts];
}

/** Ops that turn `stored` into `desired`, in apply order: entity deletes, updates and inserts, then relation deletes
 * and inserts. Keeps the lowest id per natural key. */
export function diffGraph(stored: StoredGraph, desired: DesiredGraph): GraphOp[] {
  const entityDelta = diffEntities(stored.entities, wantedEntities(desired), stored.kinds);
  return [
    ...entityDelta.ops,
    ...diffRelations(stored.relations, wantedRelations(desired), entityDelta.keptKeyById, stored.kinds),
  ];
}
