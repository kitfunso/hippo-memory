// Diffs the derived graph against the stored rows, so a rebuild writes only what changed and an entity keeps the id its relations hang on.
import type { GraphTxDb, EntityType, RelationType, SourceObjectRef } from './types.js';
import { loadStoredGraph, storedGraphOn } from '../store/graph-reads.js';
import type { StoredEntity, StoredGraph, StoredRelation } from '../store/graph-rows.js';

/** What names an object-derived entity across rebuilds; v38 has no UNIQUE on it, so the diff keeps one row per key. */
export interface NaturalKey {
  readonly entityType: EntityType;
  readonly sourceObject: SourceObjectRef;
}

export interface DesiredEntity extends NaturalKey {
  readonly name: string;
  readonly memoryId: string | null;
}

export interface DesiredRelation {
  readonly from: NaturalKey;
  readonly to: NaturalKey;
  readonly relType: RelationType;
  readonly memoryId: string | null;
  readonly sourceObject: SourceObjectRef;
}

export interface DesiredGraph {
  readonly entities: readonly DesiredEntity[];
  readonly relations: readonly DesiredRelation[];
}

export type GraphOp =
  | { readonly op: 'deleteEntity'; readonly id: number }
  | { readonly op: 'updateEntity'; readonly id: number; readonly entity: DesiredEntity }
  | { readonly op: 'insertEntity'; readonly entity: DesiredEntity }
  | { readonly op: 'deleteRelation'; readonly id: number }
  | { readonly op: 'insertRelation'; readonly relation: DesiredRelation };

const keyText = (entityType: string, objectType: string, objectId: number): string => `${entityType}|${objectType}:${objectId}`;

export function entityKey(k: NaturalKey): string {
  return keyText(k.entityType, k.sourceObject.type, k.sourceObject.id);
}

function storedKey(row: StoredEntity): string | null {
  if (row.source_object_type === null || row.source_object_id === null) return null;
  return keyText(row.entity_type, row.source_object_type, row.source_object_id);
}

const relationKey = (from: string, to: string, relType: string): string => `${from}>${to}|${relType}`;

/** Memory id to kind, so a desired row's source_kind is known before the write resolves it the same way. */
type MemoryKinds = ReadonlyMap<string, string>;

/** The (memory, kind) pair a write would store: a missing mirror leaves the object path, which is 'distilled'. */
function provenanceOf(memoryId: string | null, kinds: MemoryKinds): string {
  const kind = memoryId === null ? undefined : kinds.get(memoryId);
  return kind === undefined ? '|distilled' : `${memoryId}|${kind}`;
}

function memoryIdsOf(desired: DesiredGraph): string[] {
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

function diffEntities(stored: readonly StoredEntity[], desired: readonly DesiredEntity[], kinds: MemoryKinds): EntityDelta {
  const wanted = firstByKey(desired, entityKey);
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
    else if (row.name !== entity.name || `${row.memory_id ?? ''}|${row.source_kind}` !== provenanceOf(entity.memoryId, kinds)) {
      updates.push({ op: 'updateEntity', id: row.id, entity });
    }
  }
  const keptKeyById = new Map([...kept].map(([key, row]) => [row.id, key]));
  return { ops: [...deletes, ...updates, ...inserts], keptKeyById };
}

function diffRelations(
  stored: readonly StoredRelation[],
  desired: readonly DesiredRelation[],
  keptKeyById: ReadonlyMap<number, string>,
  kinds: MemoryKinds,
): GraphOp[] {
  const wanted = firstByKey(desired, (r) => relationKey(entityKey(r.from), entityKey(r.to), r.relType));
  const kept = new Set<string>();
  const deletes: GraphOp[] = [];
  for (const row of stored) {
    const from = keptKeyById.get(row.from_entity_id);
    const to = keptKeyById.get(row.to_entity_id);
    // An edge on a deleted entity goes with it through the v38 cascade.
    if (from === undefined || to === undefined) continue;
    const key = relationKey(from, to, row.rel_type);
    const want = wanted.get(key);
    const same = want !== undefined && !kept.has(key)
      && `${row.memory_id ?? ''}|${row.source_kind}` === provenanceOf(want.memoryId, kinds)
      && row.source_object_type === want.sourceObject.type && row.source_object_id === want.sourceObject.id;
    if (same) kept.add(key);
    else deletes.push({ op: 'deleteRelation', id: row.id });
  }
  const inserts: GraphOp[] = [];
  for (const [key, relation] of wanted) if (!kept.has(key)) inserts.push({ op: 'insertRelation', relation });
  return [...deletes, ...inserts];
}

function deltaOf(stored: StoredGraph, desired: DesiredGraph): GraphOp[] {
  const entityDelta = diffEntities(stored.entities, desired.entities, stored.kinds);
  return [...entityDelta.ops, ...diffRelations(stored.relations, desired.relations, entityDelta.keptKeyById, stored.kinds)];
}

/** Ops that turn the stored graph into `desired`, in apply order; reads only, and keeps the lowest id per natural key. */
export function graphDelta(db: GraphTxDb, tenantId: string, desired: DesiredGraph): GraphOp[] {
  return deltaOf(storedGraphOn(db, tenantId, memoryIdsOf(desired)), desired);
}

/** graphDelta on its own connection and outside any write lock; the apply re-checks each op against what changed since. */
export function readGraphDelta(hippoRoot: string, tenantId: string, desired: DesiredGraph): GraphOp[] {
  return deltaOf(loadStoredGraph(hippoRoot, tenantId, memoryIdsOf(desired)), desired);
}
