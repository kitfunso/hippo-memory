// The graph groups: the entity graph's reads and the rebuild's writes.
import type { ScopeActor } from '../../base/scope/recall-scope.js';

/** How many ids one graph read takes at a time: results come back in this order per batch, and a `limit` holds per
 * batch, so every implementation must use the same size. */
export const GRAPH_ID_BATCH = 400;

/** What one graph view reads. `limit` is a positive integer capping each read on its own; newest means createdAt, then
 * id, both descending. A row shows when it cites no memory, or its memory is in the tenant with a null scope or one
 * `canReadScope(reader, scope)` admits; no `reader` shows every row. */
export interface GraphViewQuery {
  /** Unset reads the whole graph. Set, the start entities are the first `limit` of exactly this name (lowest id first)
   * that show; none left answers empty. Per GRAPH_ID_BATCH start ids, the newest `limit` relations with an end among
   * them join in, each adding its other end to the ids held, until `limit` ids are held. */
  readonly entity?: string;
  readonly limit: number;
  readonly reader?: ScopeActor;
}

export interface GraphRows {
  readonly entities: Entity[];
  /** May name an entity `entities` lacks; the caller drops such a relation. */
  readonly relations: Relation[];
  /** Judged before a row is hidden: true when start entities, joined relations, returned relations or (whole graph)
   * returned entities came back `limit` long, or the walk held `limit` ids with a relation still to join. */
  readonly truncated: boolean;
}

/** The rows behind GET /v1/graph. */
export interface GraphReads {
  /** Every read from one snapshot, then rows that do not show are dropped. Whole graph: the tenant's newest `limit`
   * entities and relations. From a name: the entities of the ids held (id ascending, GRAPH_ID_BATCH at a time) and the
   * newest `limit` relations with both ends among those ids. */
  graphRows(tenantId: string, query: GraphViewQuery): Promise<GraphRows>;
  entitiesForMemories(tenantId: string, memoryIds: readonly string[]): Promise<Entity[]>;
  entitiesByIds(tenantId: string, ids: readonly number[]): Promise<Entity[]>;
  neighborRelations(
    tenantId: string,
    entityIds: readonly number[],
    opts: { readonly limit: number },
  ): Promise<Relation[]>;
  /** The tenant's entities and relations, each id ascending, and the kind of each of `memoryIds` held in any tenant. */
  storedGraph(tenantId: string, memoryIds: readonly string[]): Promise<StoredGraph>;
}

export type EntityType = 'person' | 'project' | 'customer' | 'system' | 'policy' | 'decision';

export type RelationType = 'owns' | 'supersedes' | 'depends-on' | 'blocked-by' | 'references';

/** The consolidated source kinds the graph is permitted to index (never 'raw'). */
export type SourceKind = 'distilled' | 'superseded';

/** The authoritative first-class object types a graph row may be anchored to (the object provenance path, alongside the
 *  memory path). Maps to source_object_type. */
export type SourceObjectType = 'decision' | 'policy' | 'customer' | 'project';

export interface Entity {
  id: number;
  tenantId: string;
  entityType: EntityType;
  name: string;
  /** The consolidated source memory this entity came from; null once the mirror is forgotten/pruned, then provenance is
   * source_object. */
  memoryId: string | null;
  sourceKind: SourceKind;
  /** The authoritative object this entity is anchored to (object-provenance path).
   *  Set for object-sourced entities; absent for memory-only (prose/NLP) entities. */
  sourceObjectType?: SourceObjectType;
  sourceObjectId?: number;
  createdAt: string;
}

export interface Relation {
  id: number;
  tenantId: string;
  fromEntityId: number;
  toEntityId: number;
  relType: RelationType;
  /** NULL once the mirror is forgotten/pruned; the relation survives via source_object. */
  memoryId: string | null;
  sourceKind: SourceKind;
  sourceObjectType?: SourceObjectType;
  sourceObjectId?: number;
  createdAt: string;
}

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

// The graph rebuild's writes: ops a diff of graphReads.storedGraph planned, applied as plain data.
export interface GraphRebuild {
  /** Applies `ops` from `opts.from` in one transaction, stopping at the first op past `opts.holdMs`. Each insert and
   * update is checked against the rows as they stand, so one a writer made stale since the diff's read is skipped. */
  applyOps(tenantId: string, ops: readonly GraphOp[], opts: ApplyGraphOpsOptions): Promise<ApplyGraphOpsResult>;
}

/** A soft (type,id) pointer to the authoritative object row a graph row descends from; survives a mirror forget/prune
 * (memory_id may go null) and is re-validated by the rebuild, not enforced by the store. */
export interface SourceObjectRef {
  type: SourceObjectType;
  id: number;
}

/** What names an object-derived entity across rebuilds; v38 enforces no unique key on it, so the diff keeps one row per
 * key. */
export interface NaturalKey {
  readonly entityType: EntityType;
  readonly sourceObject: SourceObjectRef;
}

export interface DesiredEntity extends NaturalKey {
  readonly name: string;
  readonly memoryId: string | null;
}

export interface DesiredGraph {
  readonly entities: readonly DesiredEntity[];
  readonly relations: readonly DesiredRelation[];
}

export interface DesiredRelation {
  readonly from: NaturalKey;
  readonly to: NaturalKey;
  readonly relType: RelationType;
  readonly memoryId: string | null;
  readonly sourceObject: SourceObjectRef;
}

export type GraphOp =
  | { readonly op: 'deleteEntity'; readonly id: number }
  | { readonly op: 'updateEntity'; readonly id: number; readonly entity: DesiredEntity }
  | { readonly op: 'insertEntity'; readonly entity: DesiredEntity }
  | { readonly op: 'deleteRelation'; readonly id: number }
  | { readonly op: 'insertRelation'; readonly relation: DesiredRelation };

export interface ApplyGraphOpsResult {
  readonly next: number;
  readonly skipped: number;
}

export interface ApplyGraphOpsOptions {
  readonly from: number;
  readonly holdMs: number;
}
