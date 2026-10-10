import type { Migration } from './types.js';

export const v41: Migration = {
    version: 41,
    up: (db) => {
      // Rejected-value tombstone: upsertEntryRow refuses writes matching a row's digest. No raw content stored (may be secret); no FK: it outlives its row.
      // No min_compatible_binary bump, a deliberate tradeoff: an old binary writes without the guard until upgraded (see MEMORY_ENVELOPE.md).
      db.exec(`
        CREATE TABLE IF NOT EXISTS rejected_values (
          tenant_id  TEXT NOT NULL,
          digest     TEXT NOT NULL,            -- sha256/64 of normalized content
          reason     TEXT,                     -- human-supplied; the only description stored
          rejected_by TEXT,                    -- actor ('user:<id>' / 'cli' / ...)
          rejected_at TEXT NOT NULL,
          source_memory_id TEXT,               -- provenance only; NO FK (tombstone outlives the row)
          normalized_chars INTEGER,            -- weak sanity aid for humans listing tombstones
          PRIMARY KEY (tenant_id, digest)
        ) WITHOUT ROWID;
      `);
    },
};
