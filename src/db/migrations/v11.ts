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
    // v65 drops it: no read's plan names it, and idx_memories_layer_created (v01) has its keys.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_current ON memories(layer, created) WHERE superseded_by IS NULL`,
    );
  },
};
