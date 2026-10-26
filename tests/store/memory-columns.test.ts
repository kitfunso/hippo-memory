/** The row-write column list is the base of the read list; the read list adds only the summary rebuild columns. */
import { describe, expect, it } from 'vitest';
import { MEMORY_ROW_COLUMNS, MEMORY_SELECT_COLUMNS } from '../../src/store/sqlite/rows.js';

describe('memory column lists', () => {
  it('reads every column a row write sets, plus the three rebuild columns', () => {
    const read = MEMORY_SELECT_COLUMNS.split(', ');
    expect(read.slice(0, MEMORY_ROW_COLUMNS.length)).toEqual([...MEMORY_ROW_COLUMNS]);
    expect(read.slice(MEMORY_ROW_COLUMNS.length)).toEqual(['summary_dirty', 'last_rebuilt_at', 'rebuild_count']);
    expect(MEMORY_ROW_COLUMNS).toHaveLength(37);
  });
});
