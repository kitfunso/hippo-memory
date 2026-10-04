import type { Migration } from './types.js';

export const v03: Migration = {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_conflicts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_a_id TEXT NOT NULL,
          memory_b_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          score REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          detected_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(memory_a_id, memory_b_id)
        );

        CREATE INDEX IF NOT EXISTS idx_memory_conflicts_status_updated
        ON memory_conflicts(status, updated_at DESC, id DESC);
      `);
    },
};
