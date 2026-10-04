import type { Migration } from './types.js';

export const v02: Migration = {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task TEXT NOT NULL,
          summary TEXT NOT NULL,
          next_step TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_task_snapshots_status_updated
        ON task_snapshots(status, updated_at DESC, id DESC);
      `);
    },
};
