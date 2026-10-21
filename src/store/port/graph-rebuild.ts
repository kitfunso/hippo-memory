// The graph rebuild's writes: ops a diff of graphReads.storedGraph planned, applied as plain data.
import type { EntityType, RelationType, SourceObjectType } from './graph-reads.js';

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
