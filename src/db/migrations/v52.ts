import { MEMORY_VECTORS_DDL } from '../../vector-store.js';
import type { Migration } from './types.js';

export const v52: Migration = {
    version: 52,
    // Vectors move out of embeddings.json so hybrid search reads only the rows it ranks. Additive only; the JSON import runs after COMMIT.
    up: (db) => db.exec(MEMORY_VECTORS_DDL),
};
