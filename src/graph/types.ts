import { openHippoDb } from '../db.js';

// The graph's row, queue and write-option types sit with the store's graph modules; this module stays the one place graph code imports them from.
export { GRAPH_ENTITY_TYPES, GRAPH_RELATION_TYPES, MAX_ENTITY_NAME_LEN, VALID_QUEUE_STATES, type Entity, type EntityType, type GraphQueueItem, type GraphQueueStatus, type InsertEntityOpts, type InsertRelationOpts, type Relation, type RelationType, type SourceKind, type SourceObjectRef, type SourceObjectType, type UpdateEntityOpts } from '../store/graph-rows.js';

/** The DB connection handle `openHippoDb` returns. Threaded (optionally) through
 *  the graph writers so `extractGraph` can run clear + all inserts in ONE
 *  transaction — see `runGraphRebuildTransaction`. */
export type GraphTxDb = ReturnType<typeof openHippoDb>;
