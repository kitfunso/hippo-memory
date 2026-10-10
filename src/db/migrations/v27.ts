import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v27: Migration = {
    version: 27,
    up: (db) => {
      // Self-heal: re-assert the v16 schema (api_keys + audit_log) on stores stamped past v16 whose tables are missing (dropped table or old-backup restore).
      // All CREATE IF NOT EXISTS, so a no-op for healthy stores; includes the role column so v26's ALTER is not needed on this path.
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key_id TEXT UNIQUE NOT NULL,
          key_hash TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          label TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT,
          role TEXT NOT NULL DEFAULT 'admin'
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_active
        ON api_keys(tenant_id) WHERE revoked_at IS NULL
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          actor TEXT NOT NULL,
          op TEXT NOT NULL,
          target_id TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_ts ON audit_log(tenant_id, ts DESC)`);

      // Belt-and-braces: backfill role on an api_keys table that exists without it (v16-shape table that v26's ALTER skipped on an earlier broken run).
      if (tableExists(db, 'api_keys') && !tableHasColumn(db, 'api_keys', 'role')) {
        db.exec(`ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
      }
    },
};
