import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v10: Migration = {
    version: 10,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'trace_outcome')) {
        db.exec(`ALTER TABLE memories ADD COLUMN trace_outcome TEXT`);
      }
      if (!tableHasColumn(db, 'memories', 'source_session_id')) {
        db.exec(`ALTER TABLE memories ADD COLUMN source_session_id TEXT`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_source_session_id
        ON memories(source_session_id) WHERE source_session_id IS NOT NULL
      `);
    },
};
