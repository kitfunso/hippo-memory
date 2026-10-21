// Each dashboard read hands JavaScript the same rows on a tenant five times larger: counts come from SQL aggregates, a
// page from one sorted LIMIT, the scatter from a fixed grid past its point cap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { buildOverview, buildProjectDetail } from '../../src/api/dashboard/overview.js';
import { buildMemoryPage, buildSearch, type MemoryQuery } from '../../src/api/dashboard/queries.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { recordStatementsAsync } from '../_helpers/count-statements.js';
import { replaceDetectedConflicts, writeEntriesTogether } from '../_helpers/root-forms.js';
import { dashboardOf, embed, isoAgo, makeStore, NOW, type TmpStore } from '../_helpers/dashboard-fixture.js';

const LAYERS = [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace] as const;
const BASE_ROWS = 100;
// 4,100 alpha rows, past the scatter's 4,000 point cap, so both sizes draw the grid.
const FIRST_COPIES = 41;
const FIVE_TIMES = FIRST_COPIES * 5;

const QUERY: MemoryQuery = {
  offset: 0,
  limit: 25,
  sort: 'strength',
  dir: 'asc',
  chip: 'all',
  layers: [0, 1, 2, 3],
  brush: { amin: -Infinity, amax: Infinity, smin: -Infinity, smax: Infinity },
  q: null,
};

let store: TmpStore;

function baseRows(): MemoryEntry[] {
  return Array.from({ length: BASE_ROWS }, (_, i) => ({
    ...createMemory(`alpha row ${i} ${i % 3 === 0 ? 'needle' : 'hay'}`, { tags: i % 5 === 0 ? ['Tagged'] : [] }),
    id: `mem_b${String(i).padStart(3, '0')}`,
    originProject: 'alpha',
    layer: LAYERS[i % 4],
    halfLifeDays: 5 + (i % 9) * 11,
    pinned: i % 17 === 0,
    created: isoAgo((i * 7) % 200),
    lastRetrieved: isoAgo((i * 3) % 90),
  }));
}

/** Copies every base alpha row until the project holds `copies` of each, as raw rows with fresh ids. */
function growAlphaTo(root: string, copies: number): void {
  const db = openHippoDb(root);
  try {
    // SAFETY: PRAGMA table_info answers one row per column, each with its name.
    const columns = (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((c) => c.name);
    const picked = columns.map((c) => (c === 'id' ? `memories.id || '~' || k.n` : c)).join(', ');
    db.prepare(
      `WITH RECURSIVE k(n) AS (SELECT (SELECT COUNT(*) FROM memories WHERE origin_project = 'alpha') / :base ` +
        `UNION ALL SELECT n + 1 FROM k WHERE n + 1 < :copies) INSERT INTO memories (${columns.join(', ')}) ` +
        `SELECT ${picked} FROM memories, k WHERE origin_project = 'alpha' AND instr(memories.id, '~') = 0`,
    ).run({ base: BASE_ROWS, copies });
  } finally {
    closeHippoDb(db);
  }
}

/** Rows each read handed JavaScript, keyed by read. */
async function rowsReadPerRead(): Promise<Record<string, number>> {
  const { reads, clock } = dashboardOf(store.hippoRoot, () => NOW);
  try {
    const stamp = await clock.at('default');
    const rowsOf = async <T>(read: () => Promise<T>): Promise<number> => (await recordStatementsAsync(read)).rowsRead;
    const project = await buildProjectDetail(reads, stamp, 'p:alpha');
    expect(project?.scatter.mode).toBe('grid');
    return {
      overview: await rowsOf(() => buildOverview(reads, stamp)),
      project: await rowsOf(() => buildProjectDetail(reads, stamp, 'p:alpha')),
      page: await rowsOf(() => buildMemoryPage(reads, stamp, 'p:alpha', QUERY)),
      deepPage: await rowsOf(() =>
        buildMemoryPage(reads, stamp, 'p:alpha', { ...QUERY, sort: 'content', dir: 'desc', offset: 4_000 }),
      ),
      filteredPage: await rowsOf(() =>
        buildMemoryPage(reads, stamp, 'p:alpha', { ...QUERY, chip: 'risk', q: 'needle', sort: 'last' }),
      ),
      search: await rowsOf(() => buildSearch(reads, stamp, 'needle')),
    };
  } finally {
    await reads.close();
  }
}

beforeAll(() => {
  store = makeStore('hippo-dash-bounded');
  writeEntriesTogether(store.hippoRoot, [
    ...baseRows(),
    { ...createMemory('beta row', { tags: [] }), id: 'mem_beta1', originProject: 'beta', created: isoAgo(3) },
  ]);
  replaceDetectedConflicts(store.hippoRoot, [
    { memory_a_id: 'mem_b001', memory_b_id: 'mem_b002', reason: 'inside alpha', score: 0.9 },
    { memory_a_id: 'mem_b003', memory_b_id: 'mem_beta1', reason: 'across projects', score: 0.8 },
  ]);
  embed(store.hippoRoot, ['mem_b001', 'mem_b004', 'mem_beta1']);
}, 120_000);

afterAll(() => {
  store.cleanup();
});

describe('dashboard reads at five times the rows', () => {
  it('hand JavaScript the same rows for the overview, scatter, pages and search', async () => {
    growAlphaTo(store.hippoRoot, FIRST_COPIES);
    const before = await rowsReadPerRead();
    growAlphaTo(store.hippoRoot, FIVE_TIMES);
    const after = await rowsReadPerRead();

    expect(after).toEqual(before);
  });

  it('count every row the reads leave in SQL', async () => {
    const { reads, clock } = dashboardOf(store.hippoRoot, () => NOW);
    try {
      const stamp = await clock.at('default');
      const overview = await buildOverview(reads, stamp);
      const page = await buildMemoryPage(reads, stamp, 'p:alpha', { ...QUERY, offset: BASE_ROWS * FIVE_TIMES - 10 });
      const search = await buildSearch(reads, stamp, 'needle');

      expect(overview.total).toBe(BASE_ROWS * FIVE_TIMES + 1);
      expect(page?.total).toBe(BASE_ROWS * FIVE_TIMES);
      expect(page?.rows).toHaveLength(10);
      expect(search.hits).toEqual({ 'p:alpha': 34 * FIVE_TIMES });
    } finally {
      await reads.close();
    }
  });
});
