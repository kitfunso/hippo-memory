import { describe, expect, it } from 'vitest';
import { ID_CHUNK } from '../../src/util/chunked.js';
import { GRAPH_ID_BATCH } from '../../src/store/port/graph-reads.js';
import { rowsPerStatement } from '../../src/util/sql.js';

// One-mark rows fill a statement exactly, so this is the bound-parameter limit itself.
const LIMIT = rowsPerStatement(1);

describe('the shared bound-parameter limit', () => {
  it('keeps the plain id chunk far under the limit, even with each id bound twice', () => {
    expect(ID_CHUNK * 2 + 2).toBeLessThan(LIMIT);
  });

  it('keeps the graph read batch, which a neighbour read binds twice, under the limit', () => {
    expect(GRAPH_ID_BATCH * 2 + 2).toBeLessThan(LIMIT);
  });
});
