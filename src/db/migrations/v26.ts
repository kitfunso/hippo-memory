import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v26: Migration = {
    version: 26,
    up: (db) => {
      // v1.12.0 A5 v2 sub-1: add role column to api_keys for the admin/member
      // distinction that gates /v1/sleep. Additive — existing keys backfill to
      // 'admin' via DEFAULT (single-tenant operator = admin by definition).
      // No min_compatible_binary bump: old binaries (v1.11.x) ignore the
      // column on SELECTs that don't name it; new binaries on old data run
      // this migration at openHippoDb time before any createApiKey call.
      //
      // v1.12.7 defensive: also guard on tableExists. If a DB landed in the
      // partial-v16-state (api_keys table missing despite schema_version >= 16),
      // running ALTER TABLE here would crash and block all later migrations.
      // The v27 heal below recreates api_keys with the role column already
      // present, so this ALTER becomes a no-op anyway for that path. Defense
      // in depth: guard so v26 never crashes on the partial-apply state.
      if (tableExists(db, 'api_keys') && !tableHasColumn(db, 'api_keys', 'role')) {
        db.exec(`ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
      }
    },
};
