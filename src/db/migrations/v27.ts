import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v27: Migration = {
    version: 27,
    up: (db) => {
      // v1.12.7 self-heal — re-assert the v16 schema (api_keys + audit_log).
      //
      // Surfaced 2026-05-24 on Keith's ~/.hippo/hippo.db: schema_version
      // recorded as 25 but api_keys and audit_log tables were missing from
      // migration v16. Root cause unknown — the migration runner has wrapped
      // each migration in BEGIN/COMMIT since the first SQLite commit, so
      // atomicity isn't the bug. Possible causes: DROP TABLE post-migration,
      // SQL import / restore from a pre-v16 backup over a v16+ schema_version,
      // or some edge case the wrapping doesn't catch. Cause may be operator
      // action; either way the practical fix is the same.
      //
      // All CREATE IF NOT EXISTS — zero-cost no-op for users without the
      // bug, fixes anyone who has it. Includes the role column from the
      // start so it matches v26's intent without needing v26 to ALTER on
      // this heal path.
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

      // Belt-and-braces: if api_keys existed before this migration WITHOUT
      // the role column (i.e. v16-shape table that v26's ALTER skipped due
      // to tableExists=false on an earlier broken run, then someone manually
      // CREATEd it without role), backfill role.
      if (tableExists(db, 'api_keys') && !tableHasColumn(db, 'api_keys', 'role')) {
        db.exec(`ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
      }
    },
};
