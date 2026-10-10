import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

const CREATE_TABLE_SESSION_EVENTS_SQL = `
        CREATE TABLE IF NOT EXISTS session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          task TEXT,
          event_type TEXT NOT NULL,
          content TEXT NOT NULL,
          source TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_handoffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          repo_root TEXT,
          task_id TEXT,
          summary TEXT NOT NULL,
          next_action TEXT,
          artifacts_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );
      `;

const BACKFILL_SESSION_EVENTS_TENANT_SQL = `
        UPDATE session_events
           SET tenant_id = (
             SELECT MAX(t.tenant_id) FROM task_snapshots t
              WHERE t.session_id = session_events.session_id
           )
         WHERE tenant_id = 'default'
           AND (SELECT COUNT(DISTINCT t.tenant_id) FROM task_snapshots t
                 WHERE t.session_id = session_events.session_id) = 1
      `;

const BACKFILL_SESSION_HANDOFFS_TENANT_SQL = `
        UPDATE session_handoffs
           SET tenant_id = (
             SELECT MAX(t.tenant_id) FROM task_snapshots t
              WHERE t.session_id = session_handoffs.session_id
           )
         WHERE tenant_id = 'default'
           AND (SELECT COUNT(DISTINCT t.tenant_id) FROM task_snapshots t
                 WHERE t.session_id = session_handoffs.session_id) = 1
      `;

export const v22: Migration = {
    version: 22,
    up: (db) => {
      // session_events and session_handoffs missed the v16 tenant migration (cross-tenant leak): add tenant_id (NOT NULL DEFAULT 'default') backfilled from
      // task_snapshots when unambiguous, plus a scope column. Re-run v4/v5 CREATE IF NOT EXISTS first so a partial-init store isn't stamped v22 without tables.
      db.exec(CREATE_TABLE_SESSION_EVENTS_SQL);
      if (!tableHasColumn(db, 'session_events', 'tenant_id')) {
        db.exec(`ALTER TABLE session_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'session_events', 'scope')) {
        db.exec(`ALTER TABLE session_events ADD COLUMN scope TEXT`);
      }
      if (!tableHasColumn(db, 'session_handoffs', 'tenant_id')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'session_handoffs', 'scope')) {
        db.exec(`ALTER TABLE session_handoffs ADD COLUMN scope TEXT`);
      }

      // Smart backfill: a row whose session_id maps to exactly one tenant in task_snapshots inherits it; ambiguous or unmapped rows keep 'default'.
      // The COUNT(DISTINCT) gate is load-bearing: without it a session_id spanning tenants would silently pick whichever group came first.
      db.exec(BACKFILL_SESSION_EVENTS_TENANT_SQL);
      db.exec(BACKFILL_SESSION_HANDOFFS_TENANT_SQL);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_tenant_session ON session_events(tenant_id, session_id, created_at DESC, id DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_session ON session_handoffs(tenant_id, session_id, created_at DESC)`);
    },
};
