import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v11: Migration = {
    version: 11,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'valid_from')) {
        db.exec(`ALTER TABLE memories ADD COLUMN valid_from TEXT`);
        db.exec(`UPDATE memories SET valid_from = created WHERE valid_from IS NULL`);
      }
      if (!tableHasColumn(db, 'memories', 'superseded_by')) {
        db.exec(`ALTER TABLE memories ADD COLUMN superseded_by TEXT`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_current ON memories(layer, created) WHERE superseded_by IS NULL`);
    },
};
