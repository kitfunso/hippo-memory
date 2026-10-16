import { tableHasColumn, tableExists } from '../tables.js';
import type { Migration } from './types.js';

export const v57: Migration = {
    version: 57,
    up: (db) => {
      // NULL on old rows means "no per-memory keys", so they never suppress a send; an older binary names its INSERT
      // columns, so it still writes.
      if (!tableExists(db, 'token_ledger')) return;
      if (!tableHasColumn(db, 'token_ledger', 'sent_keys')) {
        db.exec('ALTER TABLE token_ledger ADD COLUMN sent_keys TEXT');
      }
    },
};
