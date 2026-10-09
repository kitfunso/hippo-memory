import { MEMORY_QUARANTINE_DDL } from '../continuity.js';
import type { Migration } from './types.js';

export const v48: Migration = {
    version: 48,
    up: (db) => {
      // Quarantine (src/trust/quarantine.ts): a poisoned or suspect memory sits here pending
      // admin review instead of being hidden with no record. Additive only: no min_compatible_binary bump.
      db.exec(MEMORY_QUARANTINE_DDL);
    },
};
