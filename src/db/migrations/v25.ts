import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v25: Migration = {
    version: 25,
    up: (db) => {
      // v1.5.0 DAG-aware recall — cache summary metadata so the assembler can
      // reason about scope without re-walking the DAG. Three additive,
      // optional columns. No min_compatible_binary bump: these columns are
      // pure metadata; older binaries opening this DB will see them as NULL
      // / 0 and behave as before. See docs/plans/2026-05-05-dag-recall.md
      // Task 1.
      if (!tableHasColumn(db, 'memories', 'descendant_count')) {
        db.exec(`ALTER TABLE memories ADD COLUMN descendant_count INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'earliest_at')) {
        db.exec(`ALTER TABLE memories ADD COLUMN earliest_at TEXT`);
      }
      if (!tableHasColumn(db, 'memories', 'latest_at')) {
        db.exec(`ALTER TABLE memories ADD COLUMN latest_at TEXT`);
      }
      // Backfill descendant_count for existing level-2 summary rows. Use
      // dag_parent_id pointing at the summary id. Level-3 (entity profiles)
      // not built today; their descendant_count stays at default 0.
      db.exec(`
        UPDATE memories
           SET descendant_count = (
             SELECT COUNT(*) FROM memories AS c WHERE c.dag_parent_id = memories.id
           )
         WHERE dag_level >= 2
           AND descendant_count = 0
      `);
      // Backfill earliest_at / latest_at from child created timestamps for
      // existing summaries. Children of a level-2 summary are level-1 facts.
      db.exec(`
        UPDATE memories
           SET earliest_at = (
             SELECT MIN(c.created) FROM memories AS c WHERE c.dag_parent_id = memories.id
           ),
               latest_at = (
             SELECT MAX(c.created) FROM memories AS c WHERE c.dag_parent_id = memories.id
           )
         WHERE dag_level >= 2
           AND earliest_at IS NULL
      `);
    },
};
