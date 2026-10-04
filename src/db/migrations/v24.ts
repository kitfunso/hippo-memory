import type { Migration } from './types.js';

export const v24: Migration = {
    version: 24,
    up: (db) => {
      // v1.3.0 GitHub connector schema (codex round 1, 2026-05-04).
      // Six tables + a min_compatible_binary meta row for rollback safety.

      db.exec(`
        CREATE TABLE IF NOT EXISTS github_event_log (
          idempotency_key TEXT PRIMARY KEY,
          delivery_id TEXT NOT NULL,
          event_name TEXT NOT NULL,
          ingested_at TEXT NOT NULL,
          memory_id TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_log_memory ON github_event_log(memory_id) WHERE memory_id IS NOT NULL`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_event_log_delivery ON github_event_log(delivery_id)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS github_cursors (
          tenant_id TEXT NOT NULL,
          repo_full_name TEXT NOT NULL,
          issues_hwm TEXT,
          issue_comments_hwm TEXT,
          pr_review_comments_hwm TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_id, repo_full_name)
        )
      `);

      db.exec(`
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
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_github_dlq_tenant_received ON github_dlq(tenant_id, received_at)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS github_installations (
          installation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL
        )
      `);

      // PAT-mode multi-tenant routing (codex P0 #4). Maps repo_full_name to
      // tenant when the webhook envelope has no `installation` field. Composite
      // PK so the same repo can intentionally be visible to multiple tenants
      // (e.g., shared tooling accounts) — collision is on (repo, tenant) pair.
      db.exec(`
        CREATE TABLE IF NOT EXISTS github_repositories (
          repo_full_name TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          added_at TEXT NOT NULL,
          PRIMARY KEY (repo_full_name, tenant_id)
        )
      `);

      // Rollback-safety guard (codex P0 #2). Any binary < 1.2.1 lacks the
      // generic *:private:* default-deny and would leak github:private:* rows
      // if it opened this DB. The startup guard in v1.2.1+ refuses to open a
      // DB whose min_compatible_binary is newer than its own version.
      db.prepare(`INSERT INTO meta(key, value) VALUES('min_compatible_binary', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('1.2.1');
    },
};
