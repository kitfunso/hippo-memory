import type { Migration } from './types.js';

export const v59: Migration = {
    version: 59,
    up: (db) => {
      // No write path edits the graph: the triggers only queue new vectors and drop deleted ones; sleep merges them.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_vector_nodes (
          node      INTEGER PRIMARY KEY,
          memory_id TEXT NOT NULL UNIQUE,
          level     INTEGER NOT NULL,
          nbrs      BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_vector_index_meta (key TEXT PRIMARY KEY, value);
        CREATE TABLE IF NOT EXISTS memory_vector_pending (memory_id TEXT PRIMARY KEY);
        CREATE TRIGGER IF NOT EXISTS trg_memory_vectors_pending AFTER INSERT ON memory_vectors BEGIN
          INSERT OR IGNORE INTO memory_vector_pending (memory_id) VALUES (new.memory_id);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_memory_vector_nodes_delete AFTER DELETE ON memory_vectors BEGIN
          DELETE FROM memory_vector_nodes WHERE memory_id = old.memory_id;
          DELETE FROM memory_vector_pending WHERE memory_id = old.memory_id;
        END;
      `);
    },
};
