import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v04: Migration = {
    version: 4,
    up: (db) => {
      if (!tableHasColumn(db, 'task_snapshots', 'session_id')) {
        db.exec(`ALTER TABLE task_snapshots ADD COLUMN session_id TEXT`);
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          task TEXT,
          event_type TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_session_events_session_created
        ON session_events(session_id, created_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_session_events_task_created
        ON session_events(task, created_at DESC, id DESC);
      `);
    },
};
