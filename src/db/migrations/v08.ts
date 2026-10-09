import { createPhysicsTable } from '../physics-state.js';
import type { Migration } from './types.js';

export const v08: Migration = {
    version: 8,
    up: (db) => {
      createPhysicsTable(db);
    },
};
