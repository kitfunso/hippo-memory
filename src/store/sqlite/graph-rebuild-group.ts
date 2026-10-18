import { SLEEP_DB_WAIT_MS } from '../../db/index.js';
import { applyGraphOpsAt, rebuildGraphAt } from '../graph-apply.js';
import { type OnHandle, waitingOpener } from './open.js';
import type { GraphRebuild } from '../port/graph-rebuild.js';

// Sleep's wait, not a request's 250 ms: each chunk is a fresh BEGIN IMMEDIATE a hook's write could otherwise fail.
const openForChunk = waitingOpener(SLEEP_DB_WAIT_MS);

export function sqliteGraphRebuild(on: OnHandle): GraphRebuild {
  return {
    applyOps: (tenantId, ops, opts) => on((db) => applyGraphOpsAt(db, tenantId, ops, opts), openForChunk),
    rebuild: (tenantId, memoryIds, diff) => on((db) => rebuildGraphAt(db, tenantId, memoryIds, diff)),
  };
}
