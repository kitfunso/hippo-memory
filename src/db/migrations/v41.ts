import type { Migration } from './types.js';

export const v41: Migration = {
    version: 41,
    up: (db) => {
      // Rejected-value tombstone.
      // Additive table, template = v40 above. A human who rejects a fact gets
      // a durable say: the write-path guard in upsertEntryRow refuses any
      // write that would re-introduce a value whose normalized digest
      // matches a row here.
      //
      // No raw content and no preview stored. Follows the raw_archive
      // redaction precedent (raw-archive.ts payload is {redacted:true, ...}):
      // a rejected value may itself be a secret or PII ("never store my key
      // again") — persisting it in the tombstone would defeat the point. The
      // human sees the content at reject time (CLI echoes it); afterwards
      // `reason` is the human-readable identity.
      //
      // No FK on source_memory_id (v40 precedent above: tombstone outlives
      // the row it was sourced from) — provenance only.
      //
      // Reserved-word check on column names:
      // tenant/digest/reason/rejected/source/normalized/chars are non-reserved.
      //
      // No min_compatible_binary bump, a deliberate tradeoff: an old binary sharing a synced store
      // writes WITHOUT the guard until upgraded; documented in
      // MEMORY_ENVELOPE.md rather than hard-locking every old binary out of
      // the store, which is disproportionate for the dominant single-user
      // single-binary deployment.
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
