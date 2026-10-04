import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v28: Migration = {
    version: 28,
    up: (db) => {
      // E1 of 5-episode DAG live-coupling arc (docs/plans/2026-05-25-dag-e1-schema-v28.md).
      // Adds dirty-flag persistence for the existing DAG layer's level-2
      // summaries so E2 (child-write propagation) and E3 (sleep-cycle
      // rebuild) have somewhere to write + read the staleness signal. Adds
      // dag_level_3_built_at as a column (Keith Q5 pick: lets E5 entity-
      // profile build path land without a second migration).
      //
      // All columns are additive + DEFAULTed/nullable, so backfill is
      // automatic for existing rows. No min_compatible_binary bump: old
      // binaries (v1.12.x) ignore the columns on SELECTs that don't name
      // them; new binaries on old data hit this migration at openHippoDb
      // time before any DAG path touches summary_dirty.
      //
      // Precedent for column-only guards on memories: v25 (db.ts:827),
      // which added the DAG cache columns the same way. memories table
      // itself comes from v1 and is always present, so the tableExists
      // half of the v26/v27 guard pattern isn't load-bearing here.
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
        // Reserved for E5: buildEntityProfiles will set this on level-3
        // rows when they're created. Always NULL for level 0/1/2 rows.
        db.exec(`ALTER TABLE memories ADD COLUMN dag_level_3_built_at TEXT`);
      }
    },
};
