import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v13: Migration = {
    version: 13,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'dag_level')) {
        db.exec(`ALTER TABLE memories ADD COLUMN dag_level INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'dag_parent_id')) {
        db.exec(`ALTER TABLE memories ADD COLUMN dag_parent_id TEXT`);
      }
      db.exec(`UPDATE memories SET dag_level = 1 WHERE extracted_from IS NOT NULL AND dag_level = 0`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_dag_parent ON memories(dag_parent_id) WHERE dag_parent_id IS NOT NULL`);
    },
};
