// A memory page answers what the one-statement page answered before lists were kept (the snapshot was written by that
// code on this store), whether its list was sorted for it or for an earlier page; a later page reads the list, and a
// commit, a new instant or the cap sorts again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ConfidenceLevel, type EmotionalValence, Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { buildMemoryPage, type MemoryQuery } from '../../src/api/dashboard/queries.js';
import type { MemoryPage } from '../../src/api/dashboard/types.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { countMatching, recordStatementsAsync } from '../_helpers/count-statements.js';
import { replaceDetectedConflicts, writeEntriesTogether } from '../_helpers/root-forms.js';
import {
  dashboardOf,
  type DashboardView,
  isoAgo,
  makeStore,
  NOW,
  type TmpStore,
} from '../_helpers/dashboard-fixture.js';

const ROWS = 180;
const LAYERS = [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace] as const;
const CONFIDENCES: readonly ConfidenceLevel[] = ['verified', 'observed', 'inferred', 'stale'];
const VALENCES: readonly EmotionalValence[] = ['neutral', 'positive', 'negative', 'critical'];
const WORDS = ['Deploy', 'cache', 'Zeta', 'alpha', 'queue', 'Émile', 'index'];
const SCAN = /WITH open_pairs/;

const BASE: MemoryQuery = {
  offset: 0,
  limit: 9,
  sort: 'strength',
  dir: 'asc',
  chip: 'all',
  layers: [0, 1, 2, 3],
  brush: { amin: -Infinity, amax: Infinity, smin: -Infinity, smax: Infinity },
  q: null,
};

const SORTS = ['content', 'layer', 'strength', 'retrievals', 'last', 'age', 'confidence', 'scope'] as const;

/** Every sort both ways, each chip, each brush, the text test and a layer subset, alone and together. */
const QUERIES: ReadonlyArray<[string, MemoryQuery]> = [
  ...SORTS.flatMap((sort): Array<[string, MemoryQuery]> => [
    [`${sort} asc`, { ...BASE, sort }],
    [`${sort} desc`, { ...BASE, sort, dir: 'desc' }],
  ]),
  ['risk', { ...BASE, chip: 'risk' }],
  ['pinned', { ...BASE, chip: 'pinned', sort: 'age' }],
  ['conflict', { ...BASE, chip: 'conflict', sort: 'content' }],
  ['age brush', { ...BASE, brush: { ...BASE.brush, amin: 10.5, amax: 200 } }],
  ['strength brush', { ...BASE, sort: 'last', brush: { ...BASE.brush, smin: 0.2, smax: 0.8 } }],
  ['text in content', { ...BASE, q: 'kafka', sort: 'age', dir: 'desc' }],
  ['text in tags', { ...BASE, q: 'ops', sort: 'content' }],
  ['text past ascii', { ...BASE, q: 'émile' }],
  ['layers', { ...BASE, layers: [0, 2], sort: 'retrievals', dir: 'desc' }],
  [
    'all filters',
    { ...BASE, q: 'row 1', chip: 'risk', layers: [1, 2, 3], brush: { amin: 2, amax: 300, smin: 0.01, smax: 0.9 } },
  ],
];

const WINDOWS = [0, 18, 1_000];

function seedRows(): MemoryEntry[] {
  return Array.from({ length: ROWS }, (_, i) => ({
    ...createMemory(`${WORDS[i % WORDS.length]} row ${i} ${i % 4 === 0 ? 'kafka' : 'redis'}`, {
      tags: i % 6 === 0 ? ['Ops', `t${i % 3}`] : ['misc'],
    }),
    id: `mem_l${String(i).padStart(3, '0')}`,
    originProject: 'alpha',
    layer: LAYERS[i % 4],
    halfLifeDays: 3 + (i % 11) * 9,
    pinned: i % 13 === 0,
    created: isoAgo(((i * 37) % 400) + (i % 5) / 7),
    lastRetrieved: isoAgo((i * 11) % 120),
    retrievalCount: i % 9,
    confidence: CONFIDENCES[i % CONFIDENCES.length],
    emotionalValence: VALENCES[i % VALENCES.length],
    scope: i % 5 === 0 ? null : `scope-${i % 3}`,
  }));
}

function line(name: string, offset: number, page: MemoryPage | null): string {
  if (page === null) return `${name} @${offset}: null`;
  const rows = page.rows.map(
    (r) => `${r.id}:${r.strength}:${r.ageDays}:${r.lastRetrievedDays}:${r.band}${r.inConflict ? ':c' : ''}`,
  );
  return `${name} @${offset}: total=${page.total} ${JSON.stringify(page.counts)} ${JSON.stringify(page.decay)} ${rows.join(' ')}`;
}

/** Every query's windows on one reads instance, in `order`. */
async function pagesOf(view: DashboardView, order: readonly number[]): Promise<string[]> {
  const stamp = await view.clock.at('default');
  const lines: string[] = [];
  for (const [name, query] of QUERIES) {
    for (const offset of order) {
      lines.push(line(name, offset, await buildMemoryPage(view.reads, stamp, 'p:alpha', { ...query, offset })));
    }
  }
  return lines.sort();
}

let store: TmpStore;

beforeAll(() => {
  store = makeStore('hippo-dash-lists');
  writeEntriesTogether(store.hippoRoot, [
    ...seedRows(),
    { ...createMemory('beta kafka', { tags: [] }), id: 'mem_beta1', originProject: 'beta', created: isoAgo(3) },
  ]);
  replaceDetectedConflicts(store.hippoRoot, [
    { memory_a_id: 'mem_l001', memory_b_id: 'mem_l002', reason: 'inside alpha', score: 0.9 },
    { memory_a_id: 'mem_l040', memory_b_id: 'mem_beta1', reason: 'across projects', score: 0.8 },
  ]);
}, 60_000);

afterAll(() => {
  store.cleanup();
});

describe('dashboard memory lists', () => {
  it('answer every page as the single-statement page did, sorted for it or for an earlier page', async () => {
    const forward = dashboardOf(store.hippoRoot, () => NOW);
    const backward = dashboardOf(store.hippoRoot, () => NOW);
    try {
      const first = await pagesOf(forward, WINDOWS);
      expect(await pagesOf(backward, [...WINDOWS].reverse())).toEqual(first);
      expect(first).toMatchSnapshot();
    } finally {
      await forward.reads.close();
      await backward.reads.close();
    }
  });

  it('reads a later page of one stamp from the sorted list, never the project', async () => {
    const { reads, clock } = dashboardOf(store.hippoRoot, () => NOW);
    try {
      const stamp = await clock.at('default');
      await buildMemoryPage(reads, stamp, 'p:alpha', BASE);
      const later = await recordStatementsAsync(() =>
        buildMemoryPage(reads, stamp, 'p:alpha', { ...BASE, offset: 36 }),
      );
      expect(later.result?.rows).toHaveLength(BASE.limit);
      expect(countMatching(later.statements, SCAN)).toBe(0);
      // The commit signal's one row, then the page.
      expect(later.rowsRead).toBe(BASE.limit + 1);
    } finally {
      await reads.close();
    }
  });

  it('sorts again after a commit, at a new instant and past the cap of eight lists', async () => {
    let now = NOW;
    const { reads, clock } = dashboardOf(store.hippoRoot, () => now);
    const scans = async (query: MemoryQuery): Promise<number> => {
      const stamp = await clock.at('default', true);
      const log = await recordStatementsAsync(() => buildMemoryPage(reads, stamp, 'p:alpha', query));
      return countMatching(log.statements, SCAN);
    };
    try {
      const queries = SORTS.map((sort) => ({ ...BASE, sort }));
      for (const query of queries) expect(await scans(query)).toBe(1);
      expect(await scans(queries[7])).toBe(0);
      expect(await scans({ ...BASE, sort: 'age', dir: 'desc' })).toBe(1);
      // Nine lists held eight: the least recently read went.
      expect(await scans(queries[0])).toBe(1);
      expect(await scans(queries[7])).toBe(0);
      now += 1;
      expect(await scans(queries[7])).toBe(1);
      writeEntriesTogether(store.hippoRoot, [
        { ...createMemory('late kafka', { tags: [] }), id: 'mem_late', originProject: 'alpha', created: isoAgo(1) },
      ]);
      expect(await scans(queries[7])).toBe(1);
      const stamp = await clock.at('default');
      expect((await buildMemoryPage(reads, stamp, 'p:alpha', queries[7]))?.total).toBe(ROWS + 1);
    } finally {
      await reads.close();
    }
  });
});
