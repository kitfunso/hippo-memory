// Pins the dashboard reads the golden leaves out, recorded on the snapshot build before bounded reads replaced it:
// every sort, brushes, case folding past ASCII, tag hits, first-seen project order, strength cut points, a past-cap grid.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Layer, type MemoryEntry } from '../src/base/memory/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { replaceDetectedConflicts, writeEntriesTogether } from './_helpers/root-forms.js';
import {
  embed,
  get,
  isoAgo,
  makeStore,
  seed,
  startDashboard,
  type RunningDashboard,
  type TmpStore,
} from './_helpers/dashboard-fixture.js';

const LAYERS = [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace] as const;
const CONFIDENCES = ['verified', 'observed', 'inferred', 'stale'] as const;
const BIG_ROWS = 4_001;
const SAME_TIME = isoAgo(40);

let store: TmpStore;
let dash: RunningDashboard;

/** Varied alpha rows: each sort key spreads, two rows share every created time, and the cut points are hit exactly. */
function seedAlpha(root: string): void {
  seed(root, 'Zulu first', { id: 'mem_p_a01', created: SAME_TIME, retrievalCount: 3, scope: 'team:a' });
  seed(root, 'alpha shared word', { id: 'mem_p_a02', created: SAME_TIME, layer: Layer.Semantic });
  seed(root, 'Kelvin sign note', { id: 'mem_p_a03', confidence: 'verified', scope: 'Team:b' });
  seed(root, 'Ärger upper umlaut', { id: 'mem_p_a04', confidence: 'inferred', retrievalCount: 9 });
  seed(root, 'plain body', { id: 'mem_p_a05', tags: ['NeedleTag', 'ops'], confidence: 'stale' });
  // Exactly 0.5 now and 0.25 at 30 days: strong on the cut point.
  seed(root, 'on the strong cut', {
    id: 'mem_p_a06',
    halfLifeDays: 30,
    created: isoAgo(30),
    lastRetrieved: isoAgo(30),
  });
  // Exactly 0.5 at seven days: strong in the seven-day bucket.
  seed(root, 'cut at seven days', { id: 'mem_p_a07', halfLifeDays: 10, created: isoAgo(3), lastRetrieved: isoAgo(3) });
  seed(root, 'made in the future', { id: 'mem_p_a08', created: isoAgo(-3), lastRetrieved: isoAgo(-3) });
  seed(root, 'wrong twice', { id: 'mem_p_a09', outcomeNegative: 2, emotionalValence: 'negative', layer: Layer.Buffer });
  seed(root, 'pinned old', { id: 'mem_p_a10', pinned: true, created: isoAgo(200), lastRetrieved: isoAgo(120) });
  seed(root, 'trace step', { id: 'mem_p_a11', layer: Layer.Trace, created: isoAgo(95), lastRetrieved: isoAgo(95) });
  seed(root, `${'é'.repeat(239)}\u{1F600} past the cut`, { id: 'mem_p_a12', created: isoAgo(12) });
  seed(root, 'Zulu second', { id: 'mem_p_a13', retrievalCount: 3, scope: 'team:a', created: isoAgo(7) });
}

/** Projects whose first rows share alpha's first created time, so the order they are first seen in rests on ids. */
function seedOthers(root: string): void {
  seed(root, 'zeta shared word', { id: 'mem_p_z01', originProject: 'zeta', created: SAME_TIME });
  seed(root, 'beta shared word', { id: 'mem_p_b01', originProject: 'beta', created: SAME_TIME });
  seed(root, 'beta second', { id: 'mem_p_b02', originProject: 'beta' });
  seed(root, 'zeta second', { id: 'mem_p_z02', originProject: 'zeta' });
  seed(root, 'global shared word', { id: 'mem_p_g01', originProject: '' });
  seed(root, 'unassigned shared word', { id: 'mem_p_u01', originProject: null, tags: ['Shared'] });
  replaceDetectedConflicts(root, [
    { memory_a_id: 'mem_p_a01', memory_b_id: 'mem_p_a13', reason: 'inside alpha', score: 0.9 },
    { memory_a_id: 'mem_p_a02', memory_b_id: 'mem_p_b01', reason: 'across projects', score: 0.8 },
  ]);
  embed(root, ['mem_p_a01', 'mem_p_a05', 'mem_p_b01']);
}

/** One project past the scatter's point cap, its ages, strengths and layers spread over many grid cells. */
function bigRows(): MemoryEntry[] {
  return Array.from({ length: BIG_ROWS }, (_, i) => ({
    ...createMemory(`big row ${String(i).padStart(5, '0')}`, { tags: [] }),
    id: `mem_p_big${String(i).padStart(5, '0')}`,
    originProject: 'big',
    layer: LAYERS[i % 4],
    confidence: CONFIDENCES[i % 4],
    halfLifeDays: 5 + (i % 50) * 7,
    retrievalCount: i % 6,
    pinned: i % 97 === 0,
    created: isoAgo((i * 37) % 400),
    lastRetrieved: isoAgo((i * 13) % 150),
  }));
}

beforeAll(async () => {
  store = makeStore('hippo-dash-pin');
  seedAlpha(store.hippoRoot);
  seedOthers(store.hippoRoot);
  writeEntriesTogether(store.hippoRoot, bigRows());
  dash = await startDashboard(store.hippoRoot);
}, 120_000);

afterAll(async () => {
  await dash.close();
  store.cleanup();
});

const ALPHA = `/api/projects/${encodeURIComponent('p:alpha')}`;
const BIG = `/api/projects/${encodeURIComponent('p:big')}`;
const SORTS = ['content', 'layer', 'strength', 'retrievals', 'last', 'age', 'confidence', 'scope'] as const;

const READS: readonly string[] = [
  '/api/overview',
  ALPHA,
  `/api/projects/${encodeURIComponent('p:zeta')}`,
  '/api/projects/global',
  ...SORTS.flatMap((sort) => [`${ALPHA}/memories?sort=${sort}&dir=asc`, `${ALPHA}/memories?sort=${sort}&dir=desc`]),
  `${ALPHA}/memories?q=kelvin`,
  `${ALPHA}/memories?q=${encodeURIComponent('ärger')}`,
  `${ALPHA}/memories?q=needletag`,
  `${ALPHA}/memories?q=shared&chip=conflict`,
  `${ALPHA}/memories?smin=0.4&smax=0.6`,
  `${ALPHA}/memories?amin=2&amax=40&sort=age`,
  `${ALPHA}/memories?layers=episodic,trace&chip=risk&sort=age&dir=desc`,
  `${ALPHA}/memories?chip=pinned`,
  `${ALPHA}/memories?limit=3&offset=4&sort=content`,
  `${BIG}/memories?limit=5`,
  `${BIG}/memories?limit=5&offset=3990&sort=strength&dir=desc`,
  `${BIG}/memories?limit=5&offset=1200&sort=content&dir=desc`,
  `${BIG}/memories?limit=5&chip=risk&sort=last`,
  `${BIG}/memories?limit=5&chip=pinned&sort=retrievals`,
  `${BIG}/memories?limit=5&layers=semantic&smin=0.3&smax=0.7&amin=10&amax=200&sort=confidence`,
  `${BIG}/memories?limit=5&q=row%2001&sort=age&dir=desc`,
  '/api/search?q=shared',
  '/api/search?q=eta',
  '/api/search?q=kelvin',
  '/api/search?q=needletag',
  '/api/search?q=big%20row%2000',
  '/api/memory/mem_p_a06',
  '/api/memory/mem_p_a02',
];

const HASHED_OVER = 6_000;

/** Long bodies (the grid) are pinned by length and digest, so the record stays readable. */
function line(path: string, status: number, body: string): string {
  const masked = body.replace(/"snapshotId":\d+/g, '"snapshotId":"<id>"');
  if (masked.length <= HASHED_OVER) return `GET ${path} -> ${status} ${masked}`;
  const digest = createHash('sha256').update(masked).digest('hex');
  return `GET ${path} -> ${status} <${masked.length} chars sha256 ${digest}>`;
}

describe('dashboard JSON on a varied store', () => {
  it('answers each read with the body the snapshot build gave', async () => {
    const transcript: string[] = [];
    for (const path of READS) {
      const reply = await get(dash.port, path);
      transcript.push(line(path, reply.status, reply.body));
    }
    transcript.push(line(BIG, 200, (await get(dash.port, BIG)).body));
    expect(transcript).toMatchSnapshot();
  });
});
