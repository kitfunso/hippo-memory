// The graph rebuild's writes: synchronous, because `rebuild` runs its diff inside hippo.db's own write lock.
import type { StoredGraph } from './graph-reads.js';
import type { EntityType, RelationType, SourceObjectType } from './graph-reads.js';

export interface GraphRebuild {
  /** Applies `ops` from `opts.from` in one transaction, stopping at the first op past `opts.holdMs`. */
  applyOps(tenantId: string, ops: readonly GraphOp[], opts: ApplyGraphOpsOptions): ApplyGraphOpsResult;
  /** Diffs the stored graph with `diff` and applies every op under one lock; returns how many ops were stale. */
  rebuild(tenantId: string, memoryIds: readonly string[], diff: (stored: StoredGraph) => readonly GraphOp[]): number;
}

/** A soft (type,id) pointer to the authoritative object row a graph row descends from; survives a mirror forget/prune
 * (memory_id may go null) and is re-validated by the rebuild, not enforced by the store. */
export interface SourceObjectRef {
  type: SourceObjectType;
  id: number;
}

/** What names an object-derived entity across rebuilds; v38 enforces no unique key on it, so the diff keeps
 * one row per key. */
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
  readonly clock?: () => number;
}
