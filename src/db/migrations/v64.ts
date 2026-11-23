import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v64: Migration = {
  version: 64,
  up: (db) => {
    // Additive only: the first lead-in row write raises min_compatible_binary, so a store with no
    // lead-in row stays open to older binaries.
    if (!tableHasColumn(db, 'memories', 'lead_in')) {
      db.exec(`ALTER TABLE memories ADD COLUMN lead_in TEXT`);
    }
  },
};
