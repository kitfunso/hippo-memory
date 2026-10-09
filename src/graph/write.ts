// Applies a rebuild's op list on the caller's transaction. The statements and the consolidated-source guard sit in the store's graph writers.
import { assertTenantId } from '../store/tenant.js';
import { clock } from '../util/write-budget.js';
import type { DatabaseSyncLike } from '../db/index.js';
import { deleteEntityRow, deleteRelationRow, entityIdBySource, insertEntity, insertRelation, objectInForce, relationPresent, updateEntity } from '../store/graph-writes.js';
import type { DesiredRelation, GraphOp } from './delta.js';

function insertDesiredRelation(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, rel: DesiredRelation): boolean {
  const fromEntityId = entityIdBySource(db, tenantId, rel.from.entityType, rel.from.sourceObject);
  const toEntityId = entityIdBySource(db, tenantId, rel.to.entityType, rel.to.sourceObject);
  if (fromEntityId === undefined || toEntityId === undefined || !objectInForce(db, tenantId, rel.sourceObject)) return false;
  if (relationPresent(db, tenantId, fromEntityId, toEntityId, rel.relType)) return false;
  insertRelation(hippoRoot, tenantId, { fromEntityId, toEntityId, relType: rel.relType, memoryId: rel.memoryId, sourceObject: rel.sourceObject }, db);
  return true;
}

/** Applies one op; false when a writer since the diff made it stale, which the next run's diff repairs. */
function applyGraphOp(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, op: GraphOp): boolean {
  switch (op.op) {
    case 'deleteEntity':
      deleteEntityRow(db, tenantId, op.id);
      return true;
    case 'deleteRelation':
      deleteRelationRow(db, tenantId, op.id);
      return true;
    case 'updateEntity':
      if (!objectInForce(db, tenantId, op.entity.sourceObject)) return false;
      return updateEntity(hippoRoot, tenantId, op.id, op.entity, db) !== null;
    case 'insertEntity':
      // A mirrorless object closed since the load is never enqueued again, so a stale insert would stay for good.
      if (!objectInForce(db, tenantId, op.entity.sourceObject) || entityIdBySource(db, tenantId, op.entity.entityType, op.entity.sourceObject) !== undefined) return false;
      insertEntity(hippoRoot, tenantId, op.entity, db);
      return true;
    case 'insertRelation':
      return insertDesiredRelation(db, hippoRoot, tenantId, op.relation);
  }
}

export interface ApplyGraphOpsResult {
  readonly next: number;
  readonly skipped: number;
}

/** Applies `ops` from index `opts.from` on the caller's open transaction and stops at the first op boundary past `opts.holdMs`.
 *  Returns where the next chunk starts and how many ops were skipped as stale. */
export function applyGraphOps(
  db: DatabaseSyncLike,
  hippoRoot: string,
  tenantId: string,
  ops: readonly GraphOp[],
  opts: { readonly from: number; readonly holdMs: number; readonly clock?: () => number },
): ApplyGraphOpsResult {
  assertTenantId('applyGraphOps', tenantId);
  const now = opts.clock ?? clock;
  const begunAt = now();
  let next = opts.from;
  let skipped = 0;
  while (next < ops.length) {
    if (!applyGraphOp(db, hippoRoot, tenantId, ops[next])) skipped += 1;
    next += 1;
    if (now() - begunAt >= opts.holdMs) break;
  }
  return { next, skipped };
}
