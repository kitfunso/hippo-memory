// The graph's entity, relation and queue rows as hippo.db holds them, and the types every reader and writer of them shares.

export type EntityType = 'person' | 'project' | 'customer' | 'system' | 'policy' | 'decision';
export type RelationType = 'owns' | 'supersedes' | 'depends-on' | 'blocked-by' | 'references';
/** The consolidated source kinds the graph is permitted to index (never 'raw'). */
export type SourceKind = 'distilled' | 'superseded';
/** The authoritative first-class object types a graph row may be anchored to (the object
 *  provenance path, alongside the memory path). Maps to source_object_type. */
export type SourceObjectType = 'decision' | 'policy' | 'customer' | 'project';

export const GRAPH_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'person', 'project', 'customer', 'system', 'policy', 'decision',
]);

/** A soft (type,id) pointer to the authoritative object row a graph row descends from; survives a mirror forget/prune
 * (memory_id may go NULL) and is re-validated by the rebuild, not a hard FK. */
export interface SourceObjectRef {
  type: SourceObjectType;
  id: number;
}

export const GRAPH_RELATION_TYPES: ReadonlySet<RelationType> = new Set<RelationType>([
  'owns', 'supersedes', 'depends-on', 'blocked-by', 'references',
]);

export type GraphQueueStatus = 'pending' | 'processed' | 'skipped';
export const VALID_QUEUE_STATES: ReadonlySet<GraphQueueStatus> = new Set<GraphQueueStatus>([
  'pending', 'processed', 'skipped',
]);

export const MAX_ENTITY_NAME_LEN = 512;

export interface Entity {
  id: number;
  tenantId: string;
  entityType: EntityType;
  name: string;
  /** The consolidated source memory this entity came from; NULL once the mirror is forgotten/pruned (ON DELETE SET NULL), then provenance is source_object. */
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

export interface EntityRow {
  id: number;
  tenant_id: string;
  entity_type: string;
  name: string;
  memory_id: string | null;
  source_kind: string;
  source_object_type: string | null;
  source_object_id: number | null;
  created_at: string;
}
export interface RelationRow {
  id: number;
  tenant_id: string;
  from_entity_id: number;
  to_entity_id: number;
  rel_type: string;
  memory_id: string | null;
  source_kind: string;
  source_object_type: string | null;
  source_object_id: number | null;
  created_at: string;
}

export function rowToEntity(row: EntityRow): Entity {
  // SAFETY: entity_type/source_kind/source_object_type are DB CHECK-constrained to exactly the EntityType/SourceKind/SourceObjectType enum values,
  // so the row's column values match those types.
  return {
    id: row.id,
    tenantId: row.tenant_id,
    entityType: row.entity_type as EntityType,
    name: row.name,
    memoryId: row.memory_id,
    sourceKind: row.source_kind as SourceKind,
    sourceObjectType: row.source_object_type === null ? undefined : (row.source_object_type as SourceObjectType),
    sourceObjectId: row.source_object_id === null ? undefined : row.source_object_id,
    createdAt: row.created_at,
  };
}
export function rowToRelation(row: RelationRow): Relation {
  // SAFETY: rel_type/source_kind/source_object_type are DB CHECK-constrained to exactly the RelationType/SourceKind/SourceObjectType enum values,
  // so the row's column values match those types.
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    relType: row.rel_type as RelationType,
    memoryId: row.memory_id,
    sourceKind: row.source_kind as SourceKind,
    sourceObjectType: row.source_object_type === null ? undefined : (row.source_object_type as SourceObjectType),
    sourceObjectId: row.source_object_id === null ? undefined : row.source_object_id,
    createdAt: row.created_at,
  };
}

export const ENTITY_COLS = `id, tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at`;
export const RELATION_COLS = `id, tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, source_object_type, source_object_id, created_at`;

export interface GraphQueueItem {
  id: number;
  tenantId: string;
  memoryId: string;
  kind: SourceKind;
  status: GraphQueueStatus;
  enqueuedAt: string;
  processedAt: string | null;
}

export interface QueueRow {
  id: number;
  tenant_id: string;
  memory_id: string;
  kind: string;
  status: string;
  enqueued_at: string;
  processed_at: string | null;
}

export function rowToQueueItem(row: QueueRow): GraphQueueItem {
  // SAFETY: kind/status are DB CHECK-constrained to exactly the SourceKind/GraphQueueStatus enum values,
  // so the row's column values match those types.
  return {
    id: row.id,
    tenantId: row.tenant_id,
    memoryId: row.memory_id,
    kind: row.kind as SourceKind,
    status: row.status as GraphQueueStatus,
    enqueuedAt: row.enqueued_at,
    processedAt: row.processed_at,
  };
}

export const QUEUE_COLS = `id, tenant_id, memory_id, kind, status, enqueued_at, processed_at`;

export interface InsertEntityOpts {
  entityType: EntityType;
  name: string;
  /** A consolidated (distilled/superseded) memory; raw is rejected. NULL/omitted when
   *  the entity is anchored only to its source object (mirror forgotten/pruned). */
  memoryId?: string | null;
  /** The authoritative object this entity descends from. Required when memoryId is
   *  null; optional alongside a live memory (both paths may be set). */
  sourceObject?: SourceObjectRef;
}

/** What an in-place entity update may change; type and source object are the row's identity and stay. */
export interface UpdateEntityOpts {
  name: string;
  memoryId?: string | null;
}

export interface InsertRelationOpts {
  fromEntityId: number;
  toEntityId: number;
  relType: RelationType;
  /** A consolidated (distilled/superseded) memory; raw is rejected. NULL/omitted when
   *  the relation is anchored only to its source object. */
  memoryId?: string | null;
  /** The authoritative object this relation descends from. */
  sourceObject?: SourceObjectRef;
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
