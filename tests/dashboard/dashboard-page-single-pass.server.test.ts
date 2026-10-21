// A memory page answers its filter tally and its rows from one evaluation of the kept rows, and a page past the end still
// answers the tally.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMemoryPage, type MemoryQuery } from '../../src/api/dashboard/queries.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { countMatching, recordStatementsAsync } from '../_helpers/count-statements.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';
import { dashboardOf, isoAgo, makeStore, NOW, type TmpStore } from '../_helpers/dashboard-fixture.js';

const QUERY: MemoryQuery = {
  offset: 0,
  limit: 10,
  sort: 'strength',
  dir: 'asc',
  chip: 'all',
  layers: [0, 1, 2, 3],
  brush: { amin: -Infinity, amax: Infinity, smin: -Infinity, smax: Infinity },
  q: null,
};
const ROWS = 30;
let store: TmpStore;

beforeAll(() => {
  store = makeStore('hippo-dash-single-pass');
  writeEntriesTogether(
    store.hippoRoot,
    Array.from({ length: ROWS }, (_, i) => ({
      ...createMemory(`row ${i}`, { tags: [] }),
      id: `mem_r${String(i).padStart(3, '0')}`,
      originProject: 'alpha',
      pinned: i % 4 === 0,
      created: isoAgo(i * 3),
    })),
  );
}, 60_000);

afterAll(() => {
  store.cleanup();
});

describe('dashboard memory page', () => {
  it('evaluates the kept rows once for the tally and the page', async () => {
    const { reads, clock } = dashboardOf(store.hippoRoot, () => NOW);
    try {
      const stamp = await clock.at('default');
      const { result, statements } = await recordStatementsAsync(() => buildMemoryPage(reads, stamp, 'p:alpha', QUERY));
      expect(result?.total).toBe(ROWS);
      expect(result?.rows).toHaveLength(10);
      expect(countMatching(statements, /WITH open_pairs/)).toBe(1);
    } finally {
      await reads.close();
    }
  });

  it('answers the tally on a page past the end', async () => {
    const { reads, clock } = dashboardOf(store.hippoRoot, () => NOW);
    try {
      const stamp = await clock.at('default');
      const first = await buildMemoryPage(reads, stamp, 'p:alpha', QUERY);
      const past = await buildMemoryPage(reads, stamp, 'p:alpha', { ...QUERY, offset: 1_000 });
      expect(past?.rows).toEqual([]);
      expect(past?.total).toBe(ROWS);
      expect(past?.counts).toEqual(first?.counts);
    } finally {
      await reads.close();
    }
  });
});
