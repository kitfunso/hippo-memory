import type { Migration } from './types.js';

export const v58: Migration = {
    version: 58,
    up: (db) => {
      // Partial, so the many rows with no artifact stay out of the index; tenant leads to match every reader's filter.
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memories_artifact_ref ' +
          'ON memories(tenant_id, artifact_ref) WHERE artifact_ref IS NOT NULL',
      );
    },
};
