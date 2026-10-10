import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v28: Migration = {
    version: 28,
    up: (db) => {
      // Dirty-flag persistence for level-2 DAG summaries; dag_level_3_built_at lands now so the entity-profile path needs no second migration.
      // Columns are additive and DEFAULTed/nullable, so no min_compatible_binary bump. Column-only guard: memories comes from v1 and always exists.
      if (!tableHasColumn(db, 'memories', 'summary_dirty')) {
        db.exec(`ALTER TABLE memories ADD COLUMN summary_dirty INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'last_rebuilt_at')) {
        db.exec(`ALTER TABLE memories ADD COLUMN last_rebuilt_at TEXT`);
      }
      if (!tableHasColumn(db, 'memories', 'rebuild_count')) {
        db.exec(`ALTER TABLE memories ADD COLUMN rebuild_count INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'dag_level_3_built_at')) {
        // buildEntityProfiles sets this on level-3
        // rows when they're created. Always NULL for level 0/1/2 rows.
        db.exec(`ALTER TABLE memories ADD COLUMN dag_level_3_built_at TEXT`);
      }
    },
};
