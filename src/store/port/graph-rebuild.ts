// The graph rebuild's writes: synchronous, because `rebuild` runs its diff inside hippo.db's own write lock.
import type { ApplyGraphOpsOptions, ApplyGraphOpsResult } from '../graph-apply.js';
import type { GraphOp, StoredGraph } from '../graph-rows.js';

export interface GraphRebuild {
  /** Applies `ops` from `opts.from` in one transaction, stopping at the first op past `opts.holdMs`. */
  applyOps(tenantId: string, ops: readonly GraphOp[], opts: ApplyGraphOpsOptions): ApplyGraphOpsResult;
  /** Diffs the stored graph with `diff` and applies every op under one lock; returns how many ops were stale. */
  rebuild(tenantId: string, memoryIds: readonly string[], diff: (stored: StoredGraph) => readonly GraphOp[]): number;
}
