// Pins the status and JSON body of every dashboard read and write the SPA makes, on a fixed store and clock, so a
// change to how the dashboard is served moves no byte. Snapshot ids, card ids and card timestamps are masked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Layer } from '../src/base/memory/memory.js';
import { quarantineScopeFor } from '../src/domain/trust/quarantine.js';
import { createCard, replaceDetectedConflicts } from './_helpers/root-forms.js';
import {
  embed,
  get,
  isoAgo,
  makeStore,
  postJson,
  seed,
  startDashboard,
  type Json,
  type Reply,
  type RunningDashboard,
  type TmpStore,
} from './_helpers/dashboard-fixture.js';

const AT_RISK = { halfLifeDays: 10, created: isoAgo(0), lastRetrieved: isoAgo(0) } as const;
const FADING = { halfLifeDays: 100, created: isoAgo(150), lastRetrieved: isoAgo(150) } as const;

let store: TmpStore;
let dash: RunningDashboard;

beforeAll(async () => {
  store = makeStore('hippo-dash-golden');
  const root = store.hippoRoot;
  seed(root, 'zeta strong fact', { id: 'mem_g_strong', tags: ['ops'] });
  seed(root, 'risk of loss', { id: 'mem_g_risk', ...AT_RISK });
  seed(root, 'mid fading', { id: 'mem_g_fading', ...FADING });
  seed(root, 'pinned fact', { id: 'mem_g_pinned', ...AT_RISK, pinned: true });
  seed(root, 'semantic fact', { id: 'mem_g_semantic', layer: Layer.Semantic });
  seed(root, 'buffer fact', { id: 'mem_g_buffer', layer: Layer.Buffer });
  seed(root, `long ${'x'.repeat(295)}`, { id: 'mem_g_long' });
  seed(root, 'deploy target is fly', { id: 'mem_g_fly' });
  seed(root, 'deploy target is render', { id: 'mem_g_render' });
  seed(root, 'a raw receipt', { id: 'mem_g_raw', kind: 'raw' });
  seed(root, 'beta only', { id: 'mem_g_beta', originProject: 'beta' });
  seed(root, 'global note', { id: 'mem_g_global', originProject: '' });
  seed(root, 'unassigned note', { id: 'mem_g_unassigned', originProject: null });
  seed(root, 'replaced', { id: 'mem_g_superseded', kind: 'superseded', supersededBy: 'mem_g_strong' });
  seed(root, 'archived row', { id: 'mem_g_archived', kind: 'archived' });
  seed(root, 'pending review', { id: 'mem_g_quarantined', scope: quarantineScopeFor(null) });
  seed(root, 'another tenant', { id: 'mem_g_tenant_b', tenantId: 'tenant_b' });
  embed(root, ['mem_g_strong', 'mem_g_fly']);
  replaceDetectedConflicts(root, [
    { memory_a_id: 'mem_g_fly', memory_b_id: 'mem_g_render', reason: 'deploy target', score: 0.9 },
  ]);
  const parent = createCard(root, 'default', { title: 'parent', repo: 'r', contract: 'c', budget: 3 });
  createCard(root, 'default', { title: 'child', dependsOn: [parent.id] });
  dash = await startDashboard(root);
});

afterAll(async () => {
  await dash.close();
  store.cleanup();
});

/** Masks what the store or the wall clock picks: snapshot ids, card ids in first-seen order, and ISO timestamps on the
 * card routes only, since every memory timestamp comes from the fixed clock. */
function masker(): (path: string, text: string) => string {
  const cards = new Map<string, string>();
  return (path, text) => {
    const masked = text.replace(/"snapshotId":\d+/g, '"snapshotId":"<id>"');
    if (!path.startsWith('/api/cards')) return masked;
    return masked
      .replace(/card_[A-Za-z0-9]+/g, (id) => {
        if (!cards.has(id)) cards.set(id, `card_#${cards.size + 1}`);
        return cards.get(id)!;
      })
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
  };
}

const ALPHA = `/api/projects/${encodeURIComponent('p:alpha')}`;

const READS = [
  '/api/overview',
  ALPHA,
  `/api/projects/${encodeURIComponent('p:beta')}`,
  '/api/projects/global',
  '/api/projects/unassigned',
  `${ALPHA}/memories`,
  `${ALPHA}/memories?sort=content&dir=asc`,
  `${ALPHA}/memories?sort=retrievals`,
  `${ALPHA}/memories?chip=risk`,
  `${ALPHA}/memories?chip=pinned`,
  `${ALPHA}/memories?chip=conflict`,
  `${ALPHA}/memories?layers=semantic,buffer`,
  `${ALPHA}/memories?q=fact`,
  `${ALPHA}/memories?smax=0.5&amin=1`,
  `${ALPHA}/memories?limit=2&offset=1`,
  '/api/memory/mem_g_fly',
  '/api/memory/mem_g_long',
  '/api/memory/mem_g_pinned',
  '/api/search?q=fact',
  '/api/search?q=bet',
  '/api/search?q=deploy',
  '/api/cards',
  `/api/projects/${encodeURIComponent('p:nope')}`,
  '/api/memory/mem_g_tenant_b',
  '/api/memory/mem_g_superseded',
  `${ALPHA}/memories?limit=0`,
  '/api/search?q=a',
  '/api/memory/a.b',
  '/api/nope',
] as const;

const WRITES: ReadonlyArray<readonly [string, Json]> = [
  ['/api/memory/mem_g_risk/pin', { pinned: true }],
  ['/api/memory/mem_g_risk/pin', { pinned: false }],
  ['/api/memory/mem_g_semantic/wrong', {}],
  ['/api/conflicts/1/resolve', { keep: 'mem_g_fly' }],
  ['/api/conflicts/1/resolve', { keep: 'mem_g_fly' }],
  ['/api/memory/mem_g_buffer/forget', {}],
  ['/api/memory/mem_g_raw/forget', {}],
  ['/api/memory/mem_g_tenant_b/pin', { pinned: true }],
  ['/api/memory/mem_g_strong/pin', {}],
];

describe('dashboard JSON bodies', () => {
  it('answers each read and write with the pinned status and body', async () => {
    const mask = masker();
    const line = (method: string, path: string, reply: Reply): string =>
      mask(path, `${method} ${path} -> ${reply.status} ${reply.body}`);
    const transcript: string[] = [];
    for (const path of READS) transcript.push(line('GET', path, await get(dash.port, path)));
    const cardId = /"id":"(card_[A-Za-z0-9]+)"/.exec((await get(dash.port, '/api/cards')).body)?.[1];
    const cardPath = `/api/cards/${cardId}`;
    transcript.push(line('GET', cardPath, await get(dash.port, cardPath)));
    for (const [path, body] of WRITES) transcript.push(line('POST', path, await postJson(dash.port, path, body)));
    transcript.push(line('GET', '/api/overview', await get(dash.port, '/api/overview')));
    expect(transcript).toMatchSnapshot();
  });
});
