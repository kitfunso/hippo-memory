import type { Migration } from './types.js';

const PREDICTIONS_PAGE = 'idx_predictions_tenant_created ON predictions(tenant_id, created_at DESC, id DESC)';
const MEMORIES_ORIGIN = 'idx_memories_tenant_origin_created ON memories(tenant_id, origin_project, created, id)';

export const v61: Migration = {
  version: 61,
  up: (db) => {
    // Sort keys in the page's own direction, so loadAllPredictions reads a page without sorting the tenant.
    db.exec(`CREATE INDEX IF NOT EXISTS ${PREDICTIONS_PAGE}`);
    // The (created, id) order of selectEntriesFromOriginAt; the origin tally's GROUP BY reads the same index.
    db.exec(`CREATE INDEX IF NOT EXISTS ${MEMORIES_ORIGIN}`);
  },
};
