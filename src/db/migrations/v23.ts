import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v23: Migration = {
    version: 23,
    up: (db) => {
      // task_snapshots: add scope so all three continuity tables carry it.
      // Self-heal partial-init stores via CREATE TABLE IF NOT EXISTS (the v22
      // session_events / session_handoffs healing is upstream).
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task TEXT NOT NULL,
          summary TEXT NOT NULL,
          next_step TEXT NOT NULL,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          session_id TEXT,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      if (!tableHasColumn(db, 'task_snapshots', 'scope')) {
        db.exec(`ALTER TABLE task_snapshots ADD COLUMN scope TEXT`);
      }
      // Quarantine policy: pre-existing continuity rows
      // with NULL scope cannot be safely classified as public after the fact.
      // Mark them 'unknown:legacy' so the api.recall + cmdRecall default-deny
      // filter excludes them for no-scope callers. Fresh rows from new
      // writers carry NULL when scope is unspecified (legitimate non-Slack
      // writes); the 'unknown:legacy' marker is a v23-only one-shot for
      // pre-upgrade rows.
      //
      // Run UPDATEs only on tables that exist (some test paths and edge stores
      // skip v22's table healing). The UPDATEs are themselves idempotent via
      // the WHERE scope IS NULL clause, so re-running is a no-op.
      if (tableExists(db, 'task_snapshots')) {
        db.exec(`UPDATE task_snapshots SET scope = 'unknown:legacy' WHERE scope IS NULL`);
      }
      if (tableExists(db, 'session_events')) {
        db.exec(`UPDATE session_events SET scope = 'unknown:legacy' WHERE scope IS NULL`);
      }
      if (tableExists(db, 'session_handoffs')) {
        db.exec(`UPDATE session_handoffs SET scope = 'unknown:legacy' WHERE scope IS NULL`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_snapshots_tenant_scope ON task_snapshots(tenant_id, scope, status)`);
    },
};
