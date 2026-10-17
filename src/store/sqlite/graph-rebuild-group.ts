import { openHippoDb, SLEEP_DB_WAIT_MS, type DatabaseSyncLike } from '../../db/index.js';
import { applyGraphOpsAt, rebuildGraphAt } from '../graph-apply.js';
import { onHandle } from '../open.js';
import type { GraphRebuild } from '../port/graph-rebuild.js';

// Sleep's wait, not a request's 250 ms: each chunk is a fresh BEGIN IMMEDIATE a hook's write could otherwise fail.
const openForChunk = (hippoRoot: string): DatabaseSyncLike => openHippoDb(hippoRoot, { busyWaitMs: SLEEP_DB_WAIT_MS });

export function sqliteGraphRebuild(hippoRoot: string): GraphRebuild {
  return {
    applyOps: (tenantId, ops, opts) =>
      onHandle(hippoRoot, (db) => applyGraphOpsAt(db, tenantId, ops, opts), openForChunk),
    rebuild: (tenantId, memoryIds, diff) => onHandle(hippoRoot, (db) => rebuildGraphAt(db, tenantId, memoryIds, diff)),
  };
}
