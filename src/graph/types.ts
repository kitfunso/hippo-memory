import { openHippoDb } from '../db.js';

/** The DB connection handle `openHippoDb` returns. Threaded (optionally) through
 *  the graph writers so `extractGraph` can run clear + all inserts in ONE
 *  transaction — see `runGraphRebuildTransaction`. */
export type GraphTxDb = ReturnType<typeof openHippoDb>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type EntityType = 'person' | 'project' | 'customer' | 'system' | 'policy' | 'decision';
export type RelationType = 'owns' | 'supersedes' | 'depends-on' | 'blocked-by' | 'references';
export type GraphQueueStatus = 'pending' | 'processed' | 'skipped';
/** The consolidated source kinds the graph is permitted to index (never 'raw'). */
export type SourceKind = 'distilled' | 'superseded';
/** The authoritative first-class object types a graph row may be anchored to (the object
 *  provenance path, alongside the memory path). Maps to source_object_type. */
export type SourceObjectType = 'decision' | 'policy' | 'customer' | 'project';

/** A soft (type,id) pointer to the authoritative object row a graph row descends from.
 *  Survives a mirror memory forget/prune (memory_id may go NULL); the rebuild
 *  re-validates it (it is not a hard FK). */
export interface SourceObjectRef {
  type: SourceObjectType;
  id: number;
}

export const GRAPH_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'person', 'project', 'customer', 'system', 'policy', 'decision',
]);
export const GRAPH_RELATION_TYPES: ReadonlySet<RelationType> = new Set<RelationType>([
  'owns', 'supersedes', 'depends-on', 'blocked-by', 'references',
]);
export const VALID_QUEUE_STATES: ReadonlySet<GraphQueueStatus> = new Set<GraphQueueStatus>([
  'pending', 'processed', 'skipped',
]);

export const MAX_ENTITY_NAME_LEN = 512;

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

export interface GraphQueueItem {
  id: number;
  tenantId: string;
  memoryId: string;
  kind: SourceKind;
  status: GraphQueueStatus;
  enqueuedAt: string;
  processedAt: string | null;
}

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
