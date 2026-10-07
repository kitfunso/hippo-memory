import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v21: Migration = {
    version: 21,
    up: (db) => {
      // Per-row mirror cleanup tracking: a failed unlink leaves mirror_cleaned_at NULL so the
      // next openHippoDb retries it, where a one-shot global gate swallowed the failure.
      if (!tableHasColumn(db, 'raw_archive', 'mirror_cleaned_at')) {
        db.exec(`ALTER TABLE raw_archive ADD COLUMN mirror_cleaned_at TEXT`);
      }
    },
};
