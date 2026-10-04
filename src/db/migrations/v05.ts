import type { Migration } from './types.js';

export const v05: Migration = {
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          repo_root TEXT,
          task_id TEXT,
          summary TEXT NOT NULL,
          next_action TEXT,
          artifacts_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_session_handoffs_session
        ON session_handoffs(session_id, created_at DESC);
      `);
    },
};
