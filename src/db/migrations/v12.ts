import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v12: Migration = {
    version: 12,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'extracted_from')) {
        db.exec(`ALTER TABLE memories ADD COLUMN extracted_from TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_extracted_from ON memories(extracted_from) WHERE extracted_from IS NOT NULL`);
    },
};
