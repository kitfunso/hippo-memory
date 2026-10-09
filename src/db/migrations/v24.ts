import type { Migration } from './types.js';

const CREATE_TABLE_GITHUB_EVENT_LOG_SQL = `
        CREATE TABLE IF NOT EXISTS github_event_log (
          idempotency_key TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL,
          event_name TEXT NOT NULL,
          ingested_at TEXT NOT NULL,
          memory_id TEXT
        )
      `;

const CREATE_TABLE_GITHUB_CURSORS_SQL = `
        CREATE TABLE IF NOT EXISTS github_cursors (
          tenant_id TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          issues_hwm TEXT,
          issue_comments_hwm TEXT,
          pr_review_comments_hwm TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, repo_full_name)
        )
      `;

const CREATE_TABLE_GITHUB_DLQ_SQL = `
        CREATE TABLE IF NOT EXISTS github_dlq (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          raw_payload TEXT NOT NULL,
          error TEXT NOT NULL,
          event_name TEXT,
          delivery_id TEXT,
          signature TEXT,
          installation_id TEXT,
          repo_full_name TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          received_at TEXT NOT NULL,
          retried_at TEXT,
          bucket TEXT NOT NULL DEFAULT 'parse_error'
        )
      `;

const CREATE_TABLE_GITHUB_INSTALLATIONS_SQL = `
        CREATE TABLE IF NOT EXISTS github_installations (
          installation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL
        )
      `;

const CREATE_TABLE_GITHUB_REPOSITORIES_SQL = `
        CREATE TABLE IF NOT EXISTS github_repositories (
          repo_full_name TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (repo_full_name, tenant_id)
        )
      `;

export const v24: Migration = {
    version: 24,
    up: (db) => {
      // GitHub connector schema.
      // Six tables + a min_compatible_binary meta row for rollback safety.

      db.exec(CREATE_TABLE_GITHUB_EVENT_LOG_SQL);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_log_memory ON github_event_log(memory_id) WHERE memory_id IS NOT NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_log_delivery ON github_event_log(delivery_id)`);

      db.exec(CREATE_TABLE_GITHUB_CURSORS_SQL);

      db.exec(CREATE_TABLE_GITHUB_DLQ_SQL);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_dlq_tenant_received ON github_dlq(tenant_id, received_at)`);

      db.exec(CREATE_TABLE_GITHUB_INSTALLATIONS_SQL);

      // PAT-mode multi-tenant routing. Maps repo_full_name to
      // tenant when the webhook envelope has no `installation` field. Composite
      // PK so the same repo can intentionally be visible to multiple tenants
      // (e.g., shared tooling accounts) — collision is on (repo, tenant) pair.
      db.exec(CREATE_TABLE_GITHUB_REPOSITORIES_SQL);

      // Rollback-safety guard: an older binary lacks the *:private:* default-deny and would leak
      // github:private:* rows; the startup guard refuses a DB whose min_compatible_binary is newer.
      db.prepare(`INSERT INTO meta(key, value) VALUES('min_compatible_binary', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('1.2.1');
    },
};
