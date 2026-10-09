import { openHippoDb } from '../db.js';
import type { EntityType, RelationType, SourceKind, SourceObjectType } from '../store/graph-rows.js';

// The row types sit with the store's graph reads; this module stays the one place graph code imports them from.
export { GRAPH_ENTITY_TYPES, type Entity, type EntityType, type Relation, type RelationType, type SourceKind, type SourceObjectType } from '../store/graph-rows.js';

/** The DB connection handle `openHippoDb` returns. Threaded (optionally) through
 *  the graph writers so `extractGraph` can run clear + all inserts in ONE
 *  transaction — see `runGraphRebuildTransaction`. */
export type GraphTxDb = ReturnType<typeof openHippoDb>;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type GraphQueueStatus = 'pending' | 'processed' | 'skipped';

/** A soft (type,id) pointer to the authoritative object row a graph row descends from.
 *  Survives a mirror memory forget/prune (memory_id may go NULL); the rebuild
 *  re-validates it (it is not a hard FK). */
export interface SourceObjectRef {
  type: SourceObjectType;
  id: number;
}

export const GRAPH_RELATION_TYPES: ReadonlySet<RelationType> = new Set<RelationType>([
  'owns', 'supersedes', 'depends-on', 'blocked-by', 'references',
]);
export const VALID_QUEUE_STATES: ReadonlySet<GraphQueueStatus> = new Set<GraphQueueStatus>([
  'pending', 'processed', 'skipped',
]);

export const MAX_ENTITY_NAME_LEN = 512;

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
