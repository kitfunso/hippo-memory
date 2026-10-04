import type { Migration } from './types.js';

export const v15: Migration = {
    version: 15,
    up: (db) => {
      // A3 hardening (post-review): close the NULL-kind bypass and add raw_archive
      // dedup safety. Both findings landed in /review on commits 41b1f4d..6456e7d.
      //
      // (1) Original v14 triggers used `WHEN NEW.kind IS NOT NULL AND NEW.kind NOT IN (...)`.
      //     A direct INSERT/UPDATE setting kind=NULL bypassed the CHECK substitute. Replace
      //     with `WHEN NEW.kind IS NULL OR NEW.kind NOT IN (...)` so NULL is rejected too.
      // (2) Add UNIQUE(memory_id, archived_at) to raw_archive so re-archiving the same id
      //     in the same instant cannot produce ambiguous audit rows. Per-id history is still
      //     allowed (different timestamps).
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
