/** The row-write column list is the base of the read list, and every name in either is a column of the memories table. */
import { describe, expect, it } from 'vitest';
import { MEMORY_ROW_COLUMNS, MEMORY_SELECT_COLUMNS } from '../../src/store/sqlite/runtime/rows.js';
import { makeRoot, openStoreAt } from '../_helpers/make-root.js';

const root = makeRoot('memory-columns');

describe('memory column lists', () => {
  it('reads every column a row write sets, plus the three rebuild columns', () => {
    const read = MEMORY_SELECT_COLUMNS.split(', ');
    expect(read.slice(0, MEMORY_ROW_COLUMNS.length)).toEqual([...MEMORY_ROW_COLUMNS]);
    expect(read.slice(MEMORY_ROW_COLUMNS.length)).toEqual(['summary_dirty', 'last_rebuilt_at', 'rebuild_count']);
  });

  it('reads exactly the columns of the memories table, less two the store keeps itself, each once', () => {
    const db = openStoreAt(root);
    try {
      // SAFETY: PRAGMA table_info returns one row per column, with a TEXT name.
      const table = (db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>).map((c) => c.name);
      const read = MEMORY_SELECT_COLUMNS.split(', ');
      expect(read.filter((c) => !table.includes(c))).toEqual([]);
      // These two the store keeps itself (a write stamp and the content-duplicate hash); a new column must land in a list or here.
      expect(table.filter((c) => !read.includes(c)).sort()).toEqual(['duplicate_hash', 'updated_at']);
      expect(new Set(read).size).toBe(read.length);
    } finally {
      db.close();
    }
  });
});
