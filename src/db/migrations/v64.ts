import {
  CURRENT_DISTILLED,
  TEXT_OUTSIDE_TRIGRAMS,
  ensureTrigramIndex,
  isFtsMissing,
} from '../continuity.js';
import { tableHasColumn } from '../tables.js';
import { duplicateHash } from '../../base/util/same-text.js';
import { errorMessage } from '../../base/util/log.js';
import type { Migration } from './types.js';

const INDEXES = [
  `idx_memories_duplicate_hash ON memories(duplicate_hash) WHERE ${CURRENT_DISTILLED}`,
  'idx_audit_log_tenant_op_ts ON audit_log(tenant_id, op, ts DESC, id DESC)',
  'idx_memory_conflicts_updated ON memory_conflicts(updated_at)',
  `idx_memories_text_outside_trigrams ON memories(tenant_id) WHERE ${TEXT_OUTSIDE_TRIGRAMS}`,
];

// An older binary rewrites content without the hash, so its edit clears the hash and the duplicate read hashes the row
// itself; a spacing-only edit by this binary clears it too, which costs that read one more row.
const STALE_HASH_TRIGGER =
  `CREATE TRIGGER IF NOT EXISTS memories_duplicate_hash_stale AFTER UPDATE OF content ON memories ` +
  `WHEN new.content IS NOT old.content AND old.duplicate_hash IS NOT NULL ` +
  `AND new.duplicate_hash IS old.duplicate_hash BEGIN ` +
  `UPDATE memories SET duplicate_hash = NULL WHERE rowid = new.rowid; END`;

/** Hashes every current distilled row the writer has not; an SQL expression index cost each insert as much again. */
function backfillDuplicateHashes(db: Parameters<Migration['up']>[0]): void {
  if (!tableHasColumn(db, 'memories', 'duplicate_hash')) {
    db.exec('ALTER TABLE memories ADD COLUMN duplicate_hash INTEGER');
  }
  // content is NOT NULL TEXT, so String() hands the hash the text as stored.
  db.function('hippo_duplicate_hash', { deterministic: true }, (content) =>
    duplicateHash(String(content)),
  );
  db.exec(
    `UPDATE memories SET duplicate_hash = hippo_duplicate_hash(content) ` +
      `WHERE duplicate_hash IS NULL AND ${CURRENT_DISTILLED}`,
  );
}

export const v64: Migration = {
  version: 64,
  up: (db) => {
    // A SQLite without FTS5 still migrates; the open's FTS step records that and search keeps its LIKE window.
    try {
      ensureTrigramIndex(db);
    } catch (err) {
      if (!isFtsMissing(errorMessage(err))) throw err;
    }
    backfillDuplicateHashes(db);
    for (const index of INDEXES) db.exec(`CREATE INDEX IF NOT EXISTS ${index}`);
    db.exec(STALE_HASH_TRIGGER);
  },
};
