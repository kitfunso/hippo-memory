import type { Migration } from './types.js';

export const v45: Migration = {
    version: 45,
    up: (db) => {
      // Token ledger (src/store/token-ledger.ts): one row per block of memory text handed to an agent; `event` is inject, skip, reset (compaction) or reread.
      // block_hash lets the per-prompt hook skip an unchanged block; rows past retention are pruned on write. Additive: no min_compatible_binary bump.
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_ledger (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          ts         TEXT NOT NULL,
          tenant_id  TEXT NOT NULL DEFAULT 'default',
          session_id TEXT,
          surface    TEXT NOT NULL,
          event      TEXT NOT NULL,
          items      INTEGER NOT NULL DEFAULT 0,
          tokens     INTEGER NOT NULL DEFAULT 0,
          block_hash TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_token_ledger_session
          ON token_ledger(tenant_id, session_id, surface, id DESC);
        CREATE INDEX IF NOT EXISTS idx_token_ledger_ts
          ON token_ledger(ts);
      `);
    },
};
