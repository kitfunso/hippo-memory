import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v26: Migration = {
    version: 26,
    up: (db) => {
      // Add api_keys.role for the admin/member split gating /v1/sleep; existing keys backfill to 'admin' via DEFAULT. No min_compatible_binary bump.
      // Guard on tableExists: a partial-v16 DB without api_keys would crash this ALTER and block later migrations (v27 heals it with role present).
      if (tableExists(db, 'api_keys') && !tableHasColumn(db, 'api_keys', 'role')) {
        db.exec(`ALTER TABLE api_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
      }
    },
};
