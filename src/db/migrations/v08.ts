import type { Migration } from './types.js';

export const v08: Migration = {
  version: 8,
  up: (db) => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS memory_physics (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      position_blob BLOB NOT NULL,
      velocity_blob BLOB NOT NULL,
      mass REAL NOT NULL,
      charge REAL NOT NULL,
      temperature REAL NOT NULL,
      last_simulation TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memory_physics_mass
    ON memory_physics(mass DESC);
  `);
  },
};
