// The graph's entity and relation rows as hippo.db holds them, and the types every reader of them hands out.

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

export interface Entity {
  id: number;
  tenantId: string;
  entityType: EntityType;
  name: string;
  /** The consolidated source memory this entity was extracted from. NULL once the
   *  mirror is forgotten/pruned (ON DELETE SET NULL) - the entity then survives via
   *  its source_object provenance. */
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
  // SAFETY: entity_type/source_kind/source_object_type are DB CHECK-constrained
  // (see db.ts CREATE TABLE entities) to exactly the EntityType/SourceKind/
  // SourceObjectType enum values, so the row's column values match those types.
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
  // SAFETY: rel_type/source_kind/source_object_type are DB CHECK-constrained
  // (see db.ts CREATE TABLE relations) to exactly the RelationType/SourceKind/
  // SourceObjectType enum values, so the row's column values match those types.
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
