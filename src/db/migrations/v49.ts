import type { Migration } from './types.js';

export const v49: Migration = {
    version: 49,
    up: (db) => {
      // Compaction record (src/compaction-record.ts): one row per Claude Code compaction, written before it (started)
      // and after it (summarised, done). Not a memory row. Additive only: no min_compatible_binary bump.
      db.exec(`
        CREATE TABLE IF NOT EXISTS compactions (
          tenant_id       TEXT NOT NULL DEFAULT 'default',
          id              TEXT NOT NULL,
          session_id      TEXT NOT NULL,
          origin_project  TEXT NOT NULL DEFAULT '',
          compact_trigger TEXT,
          cwd             TEXT,
          transcript_path TEXT,
          snapshot_saved  INTEGER NOT NULL DEFAULT 0,
          started_at      TEXT NOT NULL,
          summarised_at   TEXT,
          summary         TEXT,
          items_json      TEXT,
          items_written   INTEGER NOT NULL DEFAULT 0,
          status          TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started','summarised','done','no-summary')),
          PRIMARY KEY (tenant_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_compactions_session
          ON compactions(tenant_id, session_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_compactions_status
          ON compactions(tenant_id, status);
      `);
    },
};
