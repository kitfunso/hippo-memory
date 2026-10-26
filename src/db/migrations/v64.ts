import { TEXT_OUTSIDE_TRIGRAMS, ensureTrigramIndex, isFtsMissing } from '../continuity.js';
import { errorMessage } from '../../base/util/log.js';
import type { DatabaseSyncLike } from '../sqlite.js';
import type { Migration } from './types.js';

// The code points JavaScript's \s matches, as src/store/rules/copies.ts lists them on the day this schema was cut.
const SPACE_CODES = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
const SPACELESS_CONTENT = SPACE_CODES.reduce((sql, code) => `replace(${sql}, char(${code}), '')`, 'content');

// Set only on a current distilled row, so the partial index holds just the rows the duplicate read groups.
const DUPLICATE_KEY =
  `duplicate_key TEXT GENERATED ALWAYS AS (CASE WHEN COALESCE(kind, 'distilled') = 'distilled' ` +
  `AND COALESCE(superseded_by, '') = '' THEN ${SPACELESS_CONTENT} END) VIRTUAL`;

const INDEXES = [
  'idx_memories_duplicate_key ON memories(duplicate_key) WHERE duplicate_key IS NOT NULL',
  'idx_audit_log_tenant_op_ts ON audit_log(tenant_id, op, ts DESC, id DESC)',
  'idx_memory_conflicts_updated ON memory_conflicts(updated_at)',
  `idx_memories_text_outside_trigrams ON memories(tenant_id) WHERE ${TEXT_OUTSIDE_TRIGRAMS}`,
];

// PRAGMA table_info leaves generated columns out; table_xinfo lists them.
function hasDuplicateKey(db: DatabaseSyncLike): boolean {
  return db.prepare(`SELECT 1 FROM pragma_table_xinfo('memories') WHERE name = 'duplicate_key'`).get() !== undefined;
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
    if (!hasDuplicateKey(db)) db.exec(`ALTER TABLE memories ADD COLUMN ${DUPLICATE_KEY}`);
    for (const index of INDEXES) db.exec(`CREATE INDEX IF NOT EXISTS ${index}`);
  },
};
