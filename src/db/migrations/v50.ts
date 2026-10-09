import type { Migration } from './types.js';

const DELIVERY_EVENTS_SCHEMA_SQL = `
        CREATE TABLE IF NOT EXISTS delivery_events (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          ts                TEXT NOT NULL,
          ledger_version    INTEGER NOT NULL,
          tenant_id         TEXT NOT NULL DEFAULT 'default',
          runtime           TEXT NOT NULL,
          event_type        TEXT NOT NULL,
          surface           TEXT NOT NULL,
          store_hash        TEXT NOT NULL,
          write_store       TEXT NOT NULL,
          project_hash      TEXT,
          session_id        TEXT,
          session_state     TEXT NOT NULL,
          host_turn_id      TEXT,
          turn_seq          INTEGER,
          duplicate_of      INTEGER,
          prompt_hash       TEXT,
          prompt_length     INTEGER NOT NULL DEFAULT 0,
          query_hash        TEXT,
          recall_trace_id   INTEGER,
          block_state       TEXT NOT NULL,
          prompt_recall     INTEGER NOT NULL DEFAULT 0,
          considered_count  INTEGER NOT NULL DEFAULT 0,
          filtered_count    INTEGER NOT NULL DEFAULT 0,
          selected_count    INTEGER NOT NULL DEFAULT 0,
          emitted_count     INTEGER NOT NULL DEFAULT 0,
          rejected_count    INTEGER NOT NULL DEFAULT 0,
          rejected_unlisted INTEGER NOT NULL DEFAULT 0,
          sections_shown    INTEGER NOT NULL DEFAULT 0,
          sections_dropped  INTEGER NOT NULL DEFAULT 0,
          budget_tokens     INTEGER NOT NULL DEFAULT 0,
          selected_tokens   INTEGER NOT NULL DEFAULT 0,
          injected_tokens   INTEGER NOT NULL DEFAULT 0,
          static_hash       TEXT,
          recall_hash       TEXT,
          emitted_hash      TEXT,
          elapsed_ms        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_delivery_events_session ON delivery_events(tenant_id, session_id, id);
        CREATE INDEX IF NOT EXISTS idx_delivery_events_ts ON delivery_events(ts);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_events_turn
          ON delivery_events(tenant_id, session_id, event_type, turn_seq) WHERE turn_seq IS NOT NULL;

        CREATE TABLE IF NOT EXISTS delivery_candidates (
          event_id     INTEGER NOT NULL REFERENCES delivery_events(id) ON DELETE CASCADE,
          tenant_id    TEXT NOT NULL DEFAULT 'default',
          memory_id    TEXT NOT NULL,          -- no FK: events outlive forgotten memories, as recall traces do
          source_store TEXT NOT NULL,
          pool         TEXT NOT NULL,
          stage        TEXT NOT NULL,
          outcome      TEXT NOT NULL,
          reason       TEXT,
          cand_rank    INTEGER,
          score        REAL,
          tokens       INTEGER,
          PRIMARY KEY (event_id, memory_id)
        ) WITHOUT ROWID;
      `;

export const v50: Migration = {
    version: 50,
    up: (db) => {
      // Per-turn delivery events (src/store/recall-trace.ts). Additive only: no min_compatible_binary bump; rollback drops both tables
      // and sets schema_version back to 49. No CHECK on enum columns since SQLite cannot alter one; delivery-recorder.ts unions are the allowlist.
      db.exec(DELIVERY_EVENTS_SCHEMA_SQL);
    },
};
