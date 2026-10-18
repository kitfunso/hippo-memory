// Applies a rebuild's op list through the row writers in graph-writes.ts, in one transaction per call.
import type { DatabaseSyncLike } from '../db/index.js';
import { clock } from '../util/write-budget.js';
import { storedGraphOn } from './sqlite/graph-reads.js';
import type { DesiredRelation, GraphOp } from './port/graph-rebuild.js';
import type { StoredGraph } from './port/graph-reads.js';
import {
  deleteEntityRow,
  deleteRelationRow,
  entityIdBySource,
  insertEntityRow,
  insertRelationRow,
  objectInForce,
  relationPresent,
  runGraphRebuildTransaction,
  updateEntityRow,
} from './sqlite/graph-writes.js';
import type { ApplyGraphOpsOptions, ApplyGraphOpsResult } from './port/graph-rebuild.js';

function insertDesiredRelation(db: DatabaseSyncLike, tenantId: string, rel: DesiredRelation): boolean {
  const fromEntityId = entityIdBySource(db, tenantId, rel.from.entityType, rel.from.sourceObject);
  const toEntityId = entityIdBySource(db, tenantId, rel.to.entityType, rel.to.sourceObject);
  if (fromEntityId === undefined || toEntityId === undefined || !objectInForce(db, tenantId, rel.sourceObject)) {
    return false;
  }
  if (relationPresent(db, tenantId, fromEntityId, toEntityId, rel.relType)) return false;
  insertRelationRow(db, tenantId, {
    fromEntityId,
    toEntityId,
    relType: rel.relType,
    memoryId: rel.memoryId,
    sourceObject: rel.sourceObject,
  });
  return true;
}

/** Applies one op; false when a writer since the diff made it stale, which the next run's diff repairs. */
function applyGraphOp(db: DatabaseSyncLike, tenantId: string, op: GraphOp): boolean {
  switch (op.op) {
    case 'deleteEntity':
      deleteEntityRow(db, tenantId, op.id);
      return true;
    case 'deleteRelation':
      deleteRelationRow(db, tenantId, op.id);
      return true;
    case 'updateEntity':
      if (!objectInForce(db, tenantId, op.entity.sourceObject)) return false;
      return updateEntityRow(db, tenantId, op.id, op.entity) !== null;
    case 'insertEntity':
      // A mirrorless object closed since the load is never enqueued again, so a stale insert would stay for good.
      if (
        !objectInForce(db, tenantId, op.entity.sourceObject) ||
        entityIdBySource(db, tenantId, op.entity.entityType, op.entity.sourceObject) !== undefined
      ) {
        return false;
      }
      insertEntityRow(db, tenantId, op.entity);
      return true;
    case 'insertRelation':
      return insertDesiredRelation(db, tenantId, op.relation);
  }
}

function applyGraphOpsOn(
  db: DatabaseSyncLike,
  tenantId: string,
  ops: readonly GraphOp[],
  opts: ApplyGraphOpsOptions,
): ApplyGraphOpsResult {
  const now = opts.clock ?? clock;
  const begunAt = now();
  let next = opts.from;
  let skipped = 0;
  while (next < ops.length) {
    if (!applyGraphOp(db, tenantId, ops[next])) skipped += 1;
    next += 1;
    if (now() - begunAt >= opts.holdMs) break;
  }
  return { next, skipped };
}

/** Applies `ops` from `opts.from` in one rebuild transaction, stopping at the first op boundary past `opts.holdMs`;
 * returns where the next chunk starts and how many ops were skipped as stale. */
export function applyGraphOpsAt(
  db: DatabaseSyncLike,
  tenantId: string,
  ops: readonly GraphOp[],
  opts: ApplyGraphOpsOptions,
): ApplyGraphOpsResult {
  return runGraphRebuildTransaction(db, tenantId, (tx) => applyGraphOpsOn(tx, tenantId, ops, opts));
}

/** Reads the stored graph, diffs it with `diff` and applies every op under one lock, so two concurrent rebuilds
 * serialize instead of both inserting a missing row. Returns how many ops were skipped as stale. */
export function rebuildGraphAt(
  db: DatabaseSyncLike,
  tenantId: string,
  memoryIds: readonly string[],
  diff: (stored: StoredGraph) => readonly GraphOp[],
): number {
  return runGraphRebuildTransaction(db, tenantId, (tx) => {
    const ops = diff(storedGraphOn(tx, tenantId, memoryIds));
    return applyGraphOpsOn(tx, tenantId, ops, { from: 0, holdMs: Infinity }).skipped;
  });
}
