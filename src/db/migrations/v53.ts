import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v53: Migration = {
    version: 53,
    up: (db) => {
      // Self-service keys record who minted them and when they stop working; both stay null for keys minted before this.
      // No floor raise here: a store with no expiring key is safe for older binaries, so the first expiring key raises it.
      if (tableExists(db, 'api_keys')) {
        if (!tableHasColumn(db, 'api_keys', 'owner_subject')) db.exec(`ALTER TABLE api_keys ADD COLUMN owner_subject TEXT`);
        if (!tableHasColumn(db, 'api_keys', 'expires_at')) db.exec(`ALTER TABLE api_keys ADD COLUMN expires_at TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_live_owner ON api_keys(tenant_id, owner_subject) WHERE revoked_at IS NULL`);
      }
    },
};
