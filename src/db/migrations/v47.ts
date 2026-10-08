import type { Migration } from './types.js';

export const v47: Migration = {
    version: 47,
    up: (db) => {
      // Scope grants (src/auth.ts): a member key reads a
      // restricted scope only by an explicit row here. Additive only: no
      // min_compatible_binary bump.
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_key_scope_grants (
          key_id     TEXT NOT NULL,
          scope      TEXT NOT NULL,
          granted_at TEXT NOT NULL,
          PRIMARY KEY(key_id, scope)
        );
      `);
    },
};
