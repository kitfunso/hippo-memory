import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

const CREATE_TABLE_RAW_ARCHIVE_SQL = `
        CREATE TABLE IF NOT EXISTS raw_archive (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL,
          archived_at TEXT NOT NULL,
          reason TEXT NOT NULL,
          archived_by TEXT,
          payload_json TEXT NOT NULL
        )
      `;

const CREATE_TRIGGER_TRG_MEMORIES_RAW_APPEND_ONLY_SQL = `
        CREATE TRIGGER IF NOT EXISTS trg_memories_raw_append_only
        BEFORE DELETE ON memories
        WHEN OLD.kind = 'raw'
        BEGIN
          SELECT RAISE(ABORT, 'raw is append-only');
        END
      `;

const CREATE_TRIGGER_TRG_MEMORIES_KIND_CHECK_INSERT_SQL = `
        CREATE TRIGGER IF NOT EXISTS trg_memories_kind_check_insert
        BEFORE INSERT ON memories
        WHEN NEW.kind IS NOT NULL AND NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived');
        END
      `;

const CREATE_TRIGGER_TRG_MEMORIES_KIND_CHECK_UPDATE_SQL = `
        CREATE TRIGGER IF NOT EXISTS trg_memories_kind_check_update
        BEFORE UPDATE ON memories
        WHEN NEW.kind IS NOT NULL AND NEW.kind NOT IN ('raw','distilled','superseded','archived')
        BEGIN
          SELECT RAISE(ABORT, 'invalid kind: must be raw|distilled|superseded|archived');
        END
      `;

export const v14: Migration = {
    version: 14,
    up: (db) => {
      // Provenance envelope: kind, scope, owner, artifact_ref.
      // SQLite ALTER TABLE ADD COLUMN cannot add CHECK; CHECK enforcement lives
      // in INSERT/UPDATE triggers added later in this migration.
      if (!tableHasColumn(db, 'memories', 'kind')) {
        db.exec(`ALTER TABLE memories ADD COLUMN kind TEXT DEFAULT 'distilled'`);
      }
      if (!tableHasColumn(db, 'memories', 'scope')) {
        db.exec(`ALTER TABLE memories ADD COLUMN scope TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope) WHERE scope IS NOT NULL`);
      }
      if (!tableHasColumn(db, 'memories', 'owner')) {
        db.exec(`ALTER TABLE memories ADD COLUMN owner TEXT`);
      }
      if (!tableHasColumn(db, 'memories', 'artifact_ref')) {
        db.exec(`ALTER TABLE memories ADD COLUMN artifact_ref TEXT`);
      }
      // Backfill kind for any rows where it's NULL (pre-migration data).
      db.exec(`UPDATE memories SET kind = 'superseded' WHERE kind IS NULL AND superseded_by IS NOT NULL`);
      db.exec(`UPDATE memories SET kind = 'distilled' WHERE kind IS NULL`);
      // raw_archive: legitimate path for kind='raw' removal (used by archiveRawMemory).
      db.exec(CREATE_TABLE_RAW_ARCHIVE_SQL);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_raw_archive_memory_id ON raw_archive(memory_id)`);
      // Append-only invariant: kind='raw' rows cannot be deleted directly.
      // Use raw_archive flow: archive-then-update-then-delete (see src/raw-archive.ts).
      db.exec(CREATE_TRIGGER_TRG_MEMORIES_RAW_APPEND_ONLY_SQL);
      // CHECK substitute: ALTER TABLE cannot add CHECK, so enforce kind allowed-set
      // via INSERT/UPDATE triggers.
      db.exec(CREATE_TRIGGER_TRG_MEMORIES_KIND_CHECK_INSERT_SQL);
      db.exec(CREATE_TRIGGER_TRG_MEMORIES_KIND_CHECK_UPDATE_SQL);
    },
};
