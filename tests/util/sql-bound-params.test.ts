import { describe, expect, it } from 'vitest';
import { ID_CHUNK } from '../../src/util/chunked.js';
import { idsPerStatement, rowsPerStatement } from '../../src/util/sql.js';

describe('the shared bound-parameter limit', () => {
  it('sizes a list whose ids bind more than once, so the statement fills the limit and never passes it', () => {
    const limit = idsPerStatement(1, 0);
    const ids = idsPerStatement(2, 2);
    expect(ids * 2 + 2).toBeLessThanOrEqual(limit);
    expect((ids + 1) * 2 + 2).toBeGreaterThan(limit);
  });

  it('agrees with the row count a VALUES statement of the same width gets', () => {
    expect(idsPerStatement(3, 0)).toBe(rowsPerStatement(3));
  });

  it('keeps the plain id chunk far under the limit', () => {
    expect(ID_CHUNK).toBeLessThan(idsPerStatement(2, 2));
  });
});
