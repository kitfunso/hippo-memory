import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v09: Migration = {
    version: 9,
    up: (db) => {
      if (!tableHasColumn(db, 'memories', 'parents_json')) {
        db.exec(`ALTER TABLE memories ADD COLUMN parents_json TEXT NOT NULL DEFAULT '[]'`);
      }
      if (!tableHasColumn(db, 'memories', 'starred')) {
        db.exec(`ALTER TABLE memories ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`);
      }
    },
};
