import type { StoreActor } from '../../scope/recall-scope.js';
import type { MethodEffects } from './effects.js';

/** How many ids one graph read takes at a time: results come back in this order per batch, and a
 * `limit` holds per batch, so every implementation must use the same size. */
export const GRAPH_ID_BATCH = 400;

/** What one graph view reads. `limit` is a positive integer capping each read on its own; newest
 * means createdAt, then id, both descending. A row shows when it cites no memory but a source object, or its memory
 * is in the tenant with a null scope or one `canReadScope(reader, scope)` admits; no `reader`
 * shows every row. */
export interface GraphViewQuery {
  readonly entity?: string;
  readonly limit: number;
  readonly reader?: StoreActor;
}

/** One read of a recall walk: ids go GRAPH_ID_BATCH at a time, rows come back in that order per
 * batch, and `truncated` is false. */
export type GraphWalkQuery =
  | { readonly by: 'memory'; readonly ids: readonly string[] }
  /** The entities among `ids`. */
  | { readonly by: 'entity'; readonly ids: readonly number[] }
  /** The newest `limit` relations with either end among `ids`; `limit`, a non-negative integer, caps the whole read. */
  | { readonly by: 'neighbor'; readonly ids: readonly number[]; readonly limit: number };

export interface GraphRows {
  readonly entities: Entity[];
  readonly relations: Relation[];
  readonly truncated: boolean;
}

/** The rows behind GET /v1/graph and recall's graph walk. */
export interface GraphReads {
  graphRows(tenantId: string, query: GraphViewQuery | GraphWalkQuery): Promise<GraphRows>;
  graphDelta(tenantId: string, desired: DesiredGraph): Promise<GraphOp[]>;
}

/** What each GraphReads method does to the store; every adapter honours it. */
export const GRAPH_READS_EFFECTS = {
  graphRows: 'read',
  graphDelta: 'read',
} as const satisfies MethodEffects<GraphReads>;

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
  memoryId: string | null;
  sourceKind: SourceKind;
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
  memoryId: string | null;
  sourceKind: SourceKind;
  sourceObjectType?: SourceObjectType;
  sourceObjectId?: number;
  createdAt: string;
}

export interface GraphRebuild {
  applyOps(
    tenantId: string,
    ops: readonly GraphOp[],
    opts: ApplyGraphOpsOptions,
  ): Promise<ApplyGraphOpsResult>;
}

/** What each GraphRebuild method does to the store; every adapter honours it. */
export const GRAPH_REBUILD_EFFECTS = {
  applyOps: 'write',
} as const satisfies MethodEffects<GraphRebuild>;

/** A soft (type,id) pointer to the authoritative object row a graph row descends from; survives
 * a mirror forget/prune (memory_id may go null) and is re-validated by the rebuild, not enforced
 * by the store. */
export interface SourceObjectRef {
  type: SourceObjectType;
  id: number;
}

/** What names an object-derived entity across rebuilds; v38 enforces no unique key on it, so the
 * diff keeps one row per key. */
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
