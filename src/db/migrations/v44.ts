import type { Migration } from './types.js';

export const v44: Migration = {
    version: 44,
    up: (db) => {
      // Dormant memories (src/store/dormant.ts): with `dormant.enabled`, sleep moves a faded memory here; `hippo dormant restore` writes entry_json back.
      // No FK to memories (the row is gone by design). Additive only: no min_compatible_binary bump, an older binary ignores the table and keeps deleting.
      db.exec(`
        CREATE TABLE IF NOT EXISTS dormant_memories (
          tenant_id  TEXT NOT NULL DEFAULT 'default',
          id         TEXT NOT NULL,
          content    TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          reason     TEXT NOT NULL,
          strength   REAL NOT NULL,
          dormant_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, id)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_dormant_memories_tenant_time
          ON dormant_memories(tenant_id, dormant_at DESC);
      `);
    },
};
