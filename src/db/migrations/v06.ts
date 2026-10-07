import type { Migration } from './types.js';

export const v06: Migration = {
    version: 6,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS working_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          session_id TEXT,
          task_id TEXT,
          importance REAL NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_working_memory_scope
        ON working_memory(scope, importance DESC, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_working_memory_session
        ON working_memory(session_id, created_at DESC);
      `);
    },
};
