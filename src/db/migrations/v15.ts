import type { Migration } from './types.js';

export const v15: Migration = {
    version: 15,
    up: (db) => {
      // Close the NULL-kind bypass: v14 triggers used `WHEN NEW.kind IS NOT NULL AND ...`, so kind=NULL slipped past; now `IS NULL OR NOT IN (...)` rejects it.
      // Add UNIQUE(memory_id, archived_at) to raw_archive so re-archiving in the same instant cannot yield ambiguous audit rows (per-id history stays allowed).
      db.exec(`DROP TRIGGER IF EXISTS trg_memories_kind_check_insert`);
      db.exec(`DROP TRIGGER IF EXISTS trg_memories_kind_check_update`);
      db.exec(`
        CREATE TRIGGER trg_memories_kind_check_insert
        BEFORE INSERT ON memories
        WHEN NEW.kind IS NULL OR NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived (not null)');
        END
      `);
      db.exec(`
        CREATE TRIGGER trg_memories_kind_check_update
        BEFORE UPDATE ON memories
        WHEN NEW.kind IS NULL OR NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived (not null)');
        END
      `);
      // Defensive: any rows that somehow have NULL kind get fixed (shouldn't exist post-v14
      // backfill, but cheap insurance).
      db.exec(`UPDATE memories SET kind = 'distilled' WHERE kind IS NULL`);
      // raw_archive uniqueness. SQLite cannot ADD CONSTRAINT, but a partial unique index
      // on (memory_id, archived_at) is equivalent for INSERT-time enforcement.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_archive_id_at
        ON raw_archive(memory_id, archived_at)
      `);
    },
};
