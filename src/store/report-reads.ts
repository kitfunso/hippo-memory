import type { MemoryEntry } from '../core/memory.js';
import type { DatabaseSyncLike } from '../db/index.js';
import { MEMORY_SELECT_COLUMNS, type MemoryRow, rowToEntry } from './sqlite/rows.js';

/** Every superseded row, the row that replaced it and that row's extraction source, in loadAllEntries' order: all a
 * correction-latency report reads. */
export function correctionEntriesAt(db: DatabaseSyncLike): MemoryEntry[] {
  const superseded = `superseded_by IS NOT NULL AND superseded_by != ''`;
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(`
    SELECT ${MEMORY_SELECT_COLUMNS} FROM memories
    WHERE (${superseded})
      OR id IN (SELECT superseded_by FROM memories WHERE ${superseded})
      OR id IN (
        SELECT extracted_from FROM memories
        WHERE extracted_from IS NOT NULL AND id IN (SELECT superseded_by FROM memories WHERE ${superseded})
      )
    ORDER BY created ASC, id ASC
  `)
    .all() as MemoryRow[];
  return rows.map(rowToEntry);
}

/** The kind='raw' rows in loadAllEntries' order: all a provenance-coverage report reads. */
export function rawEntriesAt(db: DatabaseSyncLike): MemoryEntry[] {
  // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
  const rows = db
    .prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE kind = 'raw' ORDER BY created ASC, id ASC`)
    .all() as MemoryRow[];
  return rows.map(rowToEntry);
}
