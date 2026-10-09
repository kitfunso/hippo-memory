import type { Migration } from './types.js';

export const v45: Migration = {
    version: 45,
    up: (db) => {
      // Token ledger (src/store/token-ledger.ts): one row per block of
      // memory text hippo hands an agent (hook, CLI, MCP, HTTP). `event` is 'inject'
      // (sent), 'skip' (unchanged since the session's last inject, not sent), 'reset'
      // (compaction dropped earlier injections, so the next one must be sent) or
      // 'reread' (re-read by later calls, booked at session end per call day). block_hash
      // lets the per-prompt hook skip an unchanged block. Rows older than the retention
      // window are pruned on write. Additive only: no min_compatible_binary bump.
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
