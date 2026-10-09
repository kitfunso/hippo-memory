import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

const CREATE_TABLE_API_KEYS_SQL = `
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key_id TEXT UNIQUE NOT NULL,
          key_hash TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          label TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        )
      `;

const CREATE_INDEX_IDX_API_KEYS_TENANT_ACTIVE_SQL = `
        CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_active
        ON api_keys(tenant_id) WHERE revoked_at IS NULL
      `;

const CREATE_TABLE_AUDIT_LOG_SQL = `
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          actor TEXT NOT NULL,
          op TEXT NOT NULL,
          target_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        )
      `;

export const v16: Migration = {
    version: 16,
    up: (db) => {
      // Stub auth: add tenant_id to all data tables. Single-tenant per deployment for now;
      // the columns land early so later tables don't have to backfill.
      if (!tableHasColumn(db, 'memories', 'tenant_id')) {
        db.exec(`ALTER TABLE memories ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'working_memory', 'tenant_id')) {
        db.exec(`ALTER TABLE working_memory ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'consolidation_runs', 'tenant_id')) {
        db.exec(`ALTER TABLE consolidation_runs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'task_snapshots', 'tenant_id')) {
        db.exec(`ALTER TABLE task_snapshots ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      if (!tableHasColumn(db, 'memory_conflicts', 'tenant_id')) {
        db.exec(`ALTER TABLE memory_conflicts ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
      // Composite indexes for recall hot paths. Leading column is tenant_id so
      // single-tenant lookups are O(log n).
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_tenant_created ON memories(tenant_id, created)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_working_memory_tenant ON working_memory(tenant_id, importance DESC, created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_consolidation_runs_tenant_ts ON consolidation_runs(tenant_id, timestamp DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_task_snapshots_tenant_status ON task_snapshots(tenant_id, status, updated_at DESC)`);
      // Stub auth: api_keys (scrypt-hashed; plaintext returned to caller exactly once)
      // and audit_log (append-only mutation trail). Both carry tenant_id from day 1 so
      // future multi-tenant enforcement is a config flip, not a re-migration.
      db.exec(CREATE_TABLE_API_KEYS_SQL);
      db.exec(CREATE_INDEX_IDX_API_KEYS_TENANT_ACTIVE_SQL);
      db.exec(CREATE_TABLE_AUDIT_LOG_SQL);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_ts ON audit_log(tenant_id, ts DESC)`);
    },
};
