import type { Migration } from './types.js';

export const v17: Migration = {
    version: 17,
    up: (db) => {
      // Slack ingestion: idempotency log, per-channel backfill cursors, DLQ.
      db.exec(`
        CREATE TABLE IF NOT EXISTS slack_event_log (
          event_id TEXT PRIMARY KEY,
          ingested_at TEXT NOT NULL,
          memory_id TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_slack_event_log_memory ON slack_event_log(memory_id) WHERE memory_id IS NOT NULL`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS slack_cursors (
          tenant_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          latest_ts TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, channel_id)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS slack_dlq (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          error TEXT NOT NULL,
          received_at TEXT NOT NULL,
          retried_at TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_slack_dlq_tenant_received ON slack_dlq(tenant_id, received_at)`);
      // Multi-tenant routing seam. Empty by default: single-
      // tenant deployments resolve via HIPPO_TENANT fallback. Multi-workspace
      // deployments populate this table to map team_id → tenant_id.
      db.exec(`
        CREATE TABLE IF NOT EXISTS slack_workspaces (
          team_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL
        )
      `);
    },
};
