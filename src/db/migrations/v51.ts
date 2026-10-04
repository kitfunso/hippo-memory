import type { Migration } from './types.js';

export const v51: Migration = {
    version: 51,
    up: (db) => {
      // Both indexes serve loadAmbientCandidates (src/store.ts); their WHERE text must match its SQL for the planner to pick them.
      // The drift index stays empty on a healthy store, so the drift probe is one index seek instead of a tenant scan. Additive only.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_pinned
          ON memories(tenant_id, created, id) WHERE pinned = 1;
        CREATE INDEX IF NOT EXISTS idx_memories_created_drift
          ON memories(tenant_id) WHERE superseded_by IS NULL AND (length(created) <> 24 OR created NOT LIKE '%Z');
      `);
    },
};
