import type { Migration } from './types.js';

export const v01: Migration = {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          created TEXT NOT NULL,
          last_retrieved TEXT NOT NULL,
          retrieval_count INTEGER NOT NULL,
          strength REAL NOT NULL,
          half_life_days REAL NOT NULL,
          layer TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          emotional_valence TEXT NOT NULL,
          schema_fit REAL NOT NULL,
          source TEXT NOT NULL,
          outcome_score REAL,
          conflicts_with_json TEXT NOT NULL,
          pinned INTEGER NOT NULL,
          confidence TEXT NOT NULL,
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_memories_layer_created ON memories(layer, created);
        CREATE INDEX IF NOT EXISTS idx_memories_last_retrieved ON memories(last_retrieved);

        CREATE TABLE IF NOT EXISTS consolidation_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          decayed INTEGER NOT NULL,
          merged INTEGER NOT NULL,
          removed INTEGER NOT NULL
        );
      `);
    },
};
