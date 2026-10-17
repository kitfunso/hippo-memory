import { DECAY_KEY_INDEX, DECAY_KEY_SQL } from '../decay-key.js';
import type { Migration } from './types.js';

export const v60: Migration = {
    version: 60,
    up: (db) => {
      // Pinned leads the key so pinned rows and fresh rows of one tenant are two index ranges (loadContextCandidates).
      db.exec(`CREATE INDEX IF NOT EXISTS ${DECAY_KEY_INDEX} ON memories(tenant_id, pinned, (${DECAY_KEY_SQL}))`);
    },
};
