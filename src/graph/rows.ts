import type { EntityType, RelationType, GraphQueueStatus, SourceKind, SourceObjectType, Entity, Relation, GraphQueueItem } from './types.js';

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

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
export interface QueueRow {
  id: number;
  tenant_id: string;
  memory_id: string;
  kind: string;
  status: string;
  enqueued_at: string;
  processed_at: string | null;
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
export function rowToQueueItem(row: QueueRow): GraphQueueItem {
  // SAFETY: kind/status are DB CHECK-constrained (see db.ts CREATE TABLE
  // graph_extraction_queue) to exactly the SourceKind/GraphQueueStatus enum
  // values, so the row's column values match those types.
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

export const ENTITY_COLS = `id, tenant_id, entity_type, name, memory_id, source_kind, source_object_type, source_object_id, created_at`;
export const RELATION_COLS = `id, tenant_id, from_entity_id, to_entity_id, rel_type, memory_id, source_kind, source_object_type, source_object_id, created_at`;
export const QUEUE_COLS = `id, tenant_id, memory_id, kind, status, enqueued_at, processed_at`;

// ---------------------------------------------------------------------------
// Guard helper: resolve a consolidated source memory or throw
// ---------------------------------------------------------------------------

export interface DbLike {
  prepare(sql: string): { get<T>(...params: unknown[]): T };
}
