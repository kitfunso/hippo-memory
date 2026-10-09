// The snapshot cache: when a read reuses it, when an outside commit, a dashboard write, the TTL or ?fresh=1 rebuilds it, and how it counts vectors.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Layer } from '../src/memory.js';
import { quarantineScopeFor } from '../src/quarantine.js';
import { createSnapshotService, type SnapshotService } from '../src/dashboard/dashboard-snapshot.js';
import { buildOverview } from '../src/dashboard/dashboard-queries.js';
import {
  NOW, call, embed, get, makeStore, parse, postJson, seed, startDashboard, type RunningDashboard, type TmpStore,
} from './_helpers/dashboard-fixture.js';
import type { MemoryDetail, Overview } from '../src/dashboard/dashboard-types.js';

const COALESCE_MS = 10_000;
const TTL_MS = 5 * 60_000;

let store: TmpStore;
let clock: number;
let service: SnapshotService;

beforeEach(() => {
  store = makeStore('hippo-dash-cache');
  clock = NOW;
  service = createSnapshotService(store.hippoRoot, () => clock, () => clock);
});

afterEach(() => {
  service.close();
  store.cleanup();
});

describe('snapshot reuse and rebuild', () => {
  it('reuses the snapshot when nothing was written', () => {
    seed(store.hippoRoot, 'first');
    const first = service.get('default');
    clock += COALESCE_MS + 1;

    expect(service.get('default').id).toBe(first.id);
  });

  it('seeds snapshot ids from the wall clock, not the injected clock, so they rise across restarts', () => {
    const wallBefore = Date.now();
    seed(store.hippoRoot, 'first');

    const fresh = createSnapshotService(store.hippoRoot, () => clock);
    try {
      expect(fresh.get('default').id).toBeGreaterThan(wallBefore);
    } finally {
      fresh.close();
    }
  });

  it('shows an outside write after the coalescing window, and at once with fresh', () => {
    seed(store.hippoRoot, 'first');
    const first = service.get('default');
    seed(store.hippoRoot, 'second');

    clock += COALESCE_MS - 1;
    expect(service.get('default').id).toBe(first.id);

    clock += 2;
    const later = service.get('default');
    expect(later.id).toBeGreaterThan(first.id);
    expect(later.facts).toHaveLength(2);

    seed(store.hippoRoot, 'third');
    const forced = service.get('default', true);
    expect(forced.id).toBeGreaterThan(later.id);
    expect(forced.facts).toHaveLength(3);
  });

  it('ages the cache on its own clock, so a frozen eval clock still shows an outside write', () => {
    let wall = NOW;
    const frozen = createSnapshotService(store.hippoRoot, () => NOW, () => wall);
    try {
      seed(store.hippoRoot, 'first');
      const first = frozen.get('default');
      seed(store.hippoRoot, 'second');
      wall += COALESCE_MS + 1;

      const later = frozen.get('default');
      expect(later.id).toBeGreaterThan(first.id);
      expect(later.facts).toHaveLength(2);
    } finally {
      frozen.close();
    }
  });

  it('rebuilds after the TTL even with no write', () => {
    seed(store.hippoRoot, 'first');
    const first = service.get('default');

    clock += TTL_MS + 1;

    expect(service.get('default').id).toBeGreaterThan(first.id);
  });

  it('rebuilds on the next read after invalidate', () => {
    seed(store.hippoRoot, 'first');
    const first = service.get('default');

    service.invalidate();

    expect(service.get('default').id).toBeGreaterThan(first.id);
  });

  it('serves an empty snapshot while hippo.db is missing, then picks the database up', () => {
    const emptyRoot = join(store.home, 'fresh', '.hippo');
    mkdirSync(emptyRoot, { recursive: true });
    const early = createSnapshotService(emptyRoot, () => clock, () => clock);
    try {
      expect(early.get('default').facts).toHaveLength(0);
      seed(emptyRoot, 'now there is a row');
      clock += COALESCE_MS + 1;
      expect(early.get('default').facts).toHaveLength(1);
    } finally {
      early.close();
    }
  });
});

describe('live population', () => {
  it('drops superseded, archived and quarantined rows and reports them in excluded', () => {
    seed(store.hippoRoot, 'live one');
    seed(store.hippoRoot, 'live two', { layer: Layer.Trace });
    const successor = seed(store.hippoRoot, 'the replacement');
    seed(store.hippoRoot, 'replaced', { kind: 'superseded', superseded_by: successor.id });
    seed(store.hippoRoot, 'archived row', { kind: 'archived' });
    seed(store.hippoRoot, 'quarantined row', { scope: quarantineScopeFor(null) });
    // Quarantine wins over superseded, so this row is counted once, as quarantined.
    seed(store.hippoRoot, 'both', { kind: 'superseded', superseded_by: successor.id, scope: quarantineScopeFor('x') });

    const overview = buildOverview(service.get('default'));

    expect(overview.total).toBe(3);
    expect(overview.excluded).toEqual({ superseded: 1, archived: 1, quarantined: 2 });
  });
});

describe('vector coverage', () => {
  it('imports a legacy embeddings.json on the build and counts it in that same build', () => {
    const row = seed(store.hippoRoot, 'a row');
    writeFileSync(join(store.hippoRoot, 'embeddings.json'), JSON.stringify({ [row.id]: [0.1, 0.2] }));

    const snap = service.get('default');

    expect(snap.embeddingCoverage).toBe(1);
    expect(existsSync(join(store.hippoRoot, 'embeddings.json'))).toBe(false);
  });

  it('counts no coverage for a corrupt legacy file and still builds the snapshot', () => {
    seed(store.hippoRoot, 'a row');
    writeFileSync(join(store.hippoRoot, 'embeddings.json'), '{not json');

    const snap = service.get('default');

    expect(snap.facts).toHaveLength(1);
    expect(snap.embeddingCoverage).toBe(0);
    expect(existsSync(join(store.hippoRoot, 'embeddings.json'))).toBe(false);
    expect(readdirSync(store.hippoRoot).some((f) => f.startsWith('embeddings.json.corrupt-'))).toBe(true);
  });

  it('shows a vector write once the coalescing window has passed, not before', () => {
    const row = seed(store.hippoRoot, 'a row');
    const first = service.get('default');
    expect(first.embeddingCoverage).toBe(0);

    embed(store.hippoRoot, [row.id]);
    clock += COALESCE_MS - 1;
    const inside = service.get('default');
    expect(inside.id).toBe(first.id);
    expect(inside.embeddingCoverage).toBe(0);

    clock += 2;
    const after = service.get('default');
    expect(after.id).toBeGreaterThan(first.id);
    expect(after.embeddingCoverage).toBe(1);
  });
});

describe('through the server', () => {
  let dash: RunningDashboard;

  beforeEach(async () => {
    seed(store.hippoRoot, 'before the click');
    dash = await startDashboard(store.hippoRoot, () => clock);
  });

  afterEach(async () => {
    await dash.close();
  });

  it('shows a dashboard write on the very next read, inside the coalescing window', async () => {
    const before = parse<Overview>(await get(dash.port, '/api/overview'));
    const target = seed(store.hippoRoot, 'pin me');
    const cached = parse<Overview>(await get(dash.port, '/api/overview'));
    expect(cached.snapshotId).toBe(before.snapshotId);

    const pinned = await postJson(dash.port, `/api/memory/${target.id}/pin`, { pinned: true });
    expect(pinned.status).toBe(200);
    expect(parse<MemoryDetail>(pinned).band).toBe('pinned');

    const after = parse<Overview>(await get(dash.port, '/api/overview'));
    expect(after.snapshotId).toBeGreaterThan(before.snapshotId);
    expect(after.total).toBe(2);
    expect(after.projects[0].pinned).toBe(1);
  });

  it('keeps the snapshot id across a memory-detail read and a clock move past the coalescing window', async () => {
    const target = seed(store.hippoRoot, 'read me');
    const first = parse<Overview>(await get(dash.port, '/api/overview?fresh=1'));

    expect((await get(dash.port, `/api/memory/${target.id}`)).status).toBe(200);
    clock += COALESCE_MS + 1;

    expect(parse<Overview>(await get(dash.port, '/api/overview')).snapshotId).toBe(first.snapshotId);
  });

  it('takes the detail embedded flag from the snapshot, so a new vector shows after the window', async () => {
    const target = seed(store.hippoRoot, 'embed me');
    await get(dash.port, '/api/overview?fresh=1');
    embed(store.hippoRoot, [target.id]);

    const inside = parse<MemoryDetail>(await get(dash.port, `/api/memory/${target.id}`));
    clock += COALESCE_MS + 1;
    const after = parse<MemoryDetail>(await get(dash.port, `/api/memory/${target.id}`));

    expect(inside.embedded).toBe(false);
    expect(after.embedded).toBe(true);
  });

  it('serves a first snapshotId above the last one a previous server instance issued', async () => {
    const before = parse<Overview>(await get(dash.port, '/api/overview?fresh=1'));
    await dash.close();

    dash = await startDashboard(store.hippoRoot, () => clock);
    const restarted = parse<Overview>(await get(dash.port, '/api/overview'));

    expect(restarted.snapshotId).toBeGreaterThan(before.snapshotId);
  });

  it('rebuilds on ?fresh=1 only when asked', async () => {
    const first = parse<Overview>(await get(dash.port, '/api/overview'));
    seed(store.hippoRoot, 'written elsewhere');

    const plain = parse<Overview>(await get(dash.port, '/api/overview'));
    const forced = parse<Overview>(await get(dash.port, '/api/overview?fresh=1'));

    expect(plain.snapshotId).toBe(first.snapshotId);
    expect(forced.snapshotId).toBeGreaterThan(first.snapshotId);
    expect(forced.total).toBe(2);
  });

  it('ignores ?fresh=1 on a cross-site request but honours it on a same-origin one', async () => {
    const first = parse<Overview>(await get(dash.port, '/api/overview'));
    seed(store.hippoRoot, 'written elsewhere');

    const crossSite = parse<Overview>(await call(dash.port, 'GET', '/api/overview?fresh=1', { headers: { 'Sec-Fetch-Site': 'cross-site' } }));
    const sameOrigin = parse<Overview>(await call(dash.port, 'GET', '/api/overview?fresh=1', { headers: { 'Sec-Fetch-Site': 'same-origin' } }));

    expect(crossSite.snapshotId).toBe(first.snapshotId);
    expect(sameOrigin.snapshotId).toBeGreaterThan(first.snapshotId);
  });
});
