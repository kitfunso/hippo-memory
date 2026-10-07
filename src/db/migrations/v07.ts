import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v07: Migration = {
    version: 7,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'outcome_positive')) {
        db.exec(`ALTER TABLE memories ADD COLUMN outcome_positive INTEGER NOT NULL DEFAULT 0`);
      }
      if (!tableHasColumn(db, 'memories', 'outcome_negative')) {
        db.exec(`ALTER TABLE memories ADD COLUMN outcome_negative INTEGER NOT NULL DEFAULT 0`);
      }
    },
};
