import { compareSemver, PACKAGE_VERSION } from '../../version.js';
import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v53: Migration = {
    version: 53,
    up: (db) => {
      // Self-service keys record who minted them and when they stop working; both stay null for keys minted before this.
      if (tableExists(db, 'api_keys')) {
        if (!tableHasColumn(db, 'api_keys', 'owner_subject')) db.exec(`ALTER TABLE api_keys ADD COLUMN owner_subject TEXT`);
        if (!tableHasColumn(db, 'api_keys', 'expires_at')) db.exec(`ALTER TABLE api_keys ADD COLUMN expires_at TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_live_owner ON api_keys(tenant_id, owner_subject) WHERE revoked_at IS NULL`);
      }
      // An older binary never reads expires_at and would honour expired keys, so it must refuse the store.
      // The migrating binary's own version is the floor: it knows v53, and the first release that does is not known here.
      // SAFETY: the SELECT names the single `value` column.
      const existingMin = (db.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_binary'`).get() as { value?: string } | undefined)?.value;
      if (!existingMin || compareSemver(PACKAGE_VERSION, existingMin) > 0) {
        db.prepare(`INSERT INTO meta(key, value) VALUES('min_compatible_binary', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(PACKAGE_VERSION);
      }
    },
};
