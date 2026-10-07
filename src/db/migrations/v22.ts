import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v22: Migration = {
    version: 22,
    up: (db) => {
      // session_events and session_handoffs predate the v16 tenant migration and were
      // never added to it: a cross-tenant leak whenever continuity primitives are used.
      // Adds tenant_id (NOT NULL DEFAULT 'default') with smart backfill from
      // task_snapshots.session_id when unambiguous, plus an optional scope
      // column so a private-channel-derived handoff can default-deny via the
      // same rule recall already enforces.
      //
      // Self-heal partial-init stores: re-run the v4/v5 CREATE TABLE IF NOT
      // EXISTS bodies before ALTERing. A silent skip would otherwise stamp
      // schema_version=22 on a DB missing the underlying tables, leaving
      // them permanently absent.
      db.exec(`
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
      `);
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

      // Smart backfill: rows whose session_id maps to exactly one tenant in
      // task_snapshots inherit that tenant. Ambiguous or unmapped rows stay
      // at the column default ('default'). Conservative: never crosses
      // tenant boundaries on guesses. The COUNT(DISTINCT) gate is the load-
      // bearing check; without it, rows with multiple tenants under the same
      // session_id would silently pick whichever group came first.
      db.exec(`
        UPDATE session_events
           SET tenant_id = (
             SELECT MAX(t.tenant_id) FROM task_snapshots t
              WHERE t.session_id = session_events.session_id
           )
         WHERE tenant_id = 'default'
           AND (SELECT COUNT(DISTINCT t.tenant_id) FROM task_snapshots t
                 WHERE t.session_id = session_events.session_id) = 1
      `);
      db.exec(`
        UPDATE session_handoffs
           SET tenant_id = (
             SELECT MAX(t.tenant_id) FROM task_snapshots t
              WHERE t.session_id = session_handoffs.session_id
           )
         WHERE tenant_id = 'default'
           AND (SELECT COUNT(DISTINCT t.tenant_id) FROM task_snapshots t
                 WHERE t.session_id = session_handoffs.session_id) = 1
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_tenant_session ON session_events(tenant_id, session_id, created_at DESC, id DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_session_handoffs_tenant_session ON session_handoffs(tenant_id, session_id, created_at DESC)`);
    },
};
