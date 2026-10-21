import type { Migration } from './types.js';
import { DAG_LEVEL } from '../../base/memory/memory.js';

const DIRTY_SUMMARIES = 'idx_memories_summary_dirty ON memories(latest_at DESC, id) WHERE summary_dirty = 1';
const OPEN_L2 =
  `idx_memories_l2_unparented ON memories(created, id) ` +
  `WHERE dag_level = ${DAG_LEVEL.topic} AND dag_parent_id IS NULL AND superseded_by IS NULL`;
const CONFLICT_AUDIT = `idx_audit_log_conflict_resolve ON audit_log(ts) WHERE op = 'conflict_resolve'`;
const UNCLEANED_MIRRORS = 'idx_raw_archive_mirror_pending ON raw_archive(memory_id) WHERE mirror_cleaned_at IS NULL';

export const v62: Migration = {
  version: 62,
  up: (db) => {
    // Each WHERE names the rare rows, and repeats the read's own terms so SQLite can prove the index covers it.
    db.exec(`CREATE INDEX IF NOT EXISTS ${DIRTY_SUMMARIES}`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${OPEN_L2}`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${CONFLICT_AUDIT}`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${UNCLEANED_MIRRORS}`);
  },
};
