import type { Migration } from './types.js';

export const v46: Migration = {
    version: 46,
    up: (db) => {
      // Failure log (src/failure-log.ts): hashes only, since failure text can carry paths and secrets.
      // Additive only: no min_compatible_binary bump.
      db.exec(`
        CREATE TABLE IF NOT EXISTS failure_log (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ts          TEXT NOT NULL,
          tenant_id   TEXT NOT NULL DEFAULT 'default',
          session_id  TEXT,
          tool        TEXT,
          outcome     TEXT NOT NULL,
          skip_rule   TEXT,
          sig_hash    TEXT,
          detail_hash TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_failure_log_tenant
          ON failure_log(tenant_id, id);
        CREATE INDEX IF NOT EXISTS idx_failure_log_ts
          ON failure_log(ts);
      `);
    },
};
