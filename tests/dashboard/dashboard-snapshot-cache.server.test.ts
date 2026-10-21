// The snapshot id: when a read keeps it, when an outside commit, a dashboard write, the TTL or ?fresh=1 moves it, and how
// reads count vectors.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Layer } from '../src/base/memory/memory.js';
import { quarantineScopeFor } from '../src/domain/trust/quarantine.js';
import { buildOverview } from '../src/api/dashboard/overview.js';
import {
  NOW,
  call,
  dashboardOf,
  embed,
  get,
  makeStore,
  parse,
  postJson,
  seed,
  startDashboard,
  type DashboardView,
  type RunningDashboard,
  type TmpStore,
} from './_helpers/dashboard-fixture.js';
import type { MemoryDetail, Overview } from '../src/api/dashboard/types.js';

const COALESCE_MS = 10_000;
const TTL_MS = 5 * 60_000;

let store: TmpStore;
let clock: number;
let view: DashboardView;

beforeEach(() => {
  store = makeStore('hippo-dash-cache');
  clock = NOW;
  view = dashboardOf(
    store.hippoRoot,
    () => clock,
    () => clock,
  );
});

afterEach(async () => {
  await view.reads.close();
  store.cleanup();
});

/** The overview one dashboard read serves, stamped by the clock of `on`. */
async function overview(fresh = false, on: DashboardView = view): Promise<Overview> {
  return buildOverview(on.reads, await on.clock.at('default', fresh));
}

describe('snapshot id', () => {
  it('keeps the id when nothing was written', async () => {
    seed(store.hippoRoot, 'first');
    const first = await overview();
    clock += COALESCE_MS + 1;

    expect((await overview()).snapshotId).toBe(first.snapshotId);
  });

  it('seeds snapshot ids from the wall clock, not the injected clock, so they rise across restarts', async () => {
    const wallBefore = Date.now();
    seed(store.hippoRoot, 'first');

    const fresh = dashboardOf(store.hippoRoot, () => clock);
    try {
      expect((await overview(false, fresh)).snapshotId).toBeGreaterThan(wallBefore);
    } finally {
      await fresh.reads.close();
    }
  });

  it('reads an outside write at once, and moves the id after the coalescing window or with fresh', async () => {
    seed(store.hippoRoot, 'first');
    const first = await overview();
    seed(store.hippoRoot, 'second');

    clock += COALESCE_MS - 1;
    const inside = await overview();
    expect(inside.snapshotId).toBe(first.snapshotId);
    expect(inside.total).toBe(2);

    clock += 2;
    const later = await overview();
    expect(later.snapshotId).toBeGreaterThan(first.snapshotId);
    expect(later.total).toBe(2);

    seed(store.hippoRoot, 'third');
    const forced = await overview(true);
    expect(forced.snapshotId).toBeGreaterThan(later.snapshotId);
    expect(forced.total).toBe(3);
  });

  it('ages the id on its own clock, so a frozen eval clock still moves it after an outside write', async () => {
    let wall = NOW;
    const frozen = dashboardOf(
      store.hippoRoot,
      () => NOW,
      () => wall,
    );
    try {
      seed(store.hippoRoot, 'first');
      const first = await overview(false, frozen);
      seed(store.hippoRoot, 'second');
      wall += COALESCE_MS + 1;

      const later = await overview(false, frozen);
      expect(later.snapshotId).toBeGreaterThan(first.snapshotId);
      expect(later.total).toBe(2);
    } finally {
      await frozen.reads.close();
    }
  });

  it('moves the id after the TTL even with no write', async () => {
    seed(store.hippoRoot, 'first');
    const first = await overview();

    clock += TTL_MS + 1;

    expect((await overview()).snapshotId).toBeGreaterThan(first.snapshotId);
  });

  it('moves the id on the next read after invalidate', async () => {
    seed(store.hippoRoot, 'first');
    const first = await overview();

    view.clock.invalidate();

    expect((await overview()).snapshotId).toBeGreaterThan(first.snapshotId);
  });

  it('answers empty while hippo.db is missing, creates none, then picks the database up', async () => {
    const emptyRoot = join(store.home, 'fresh', '.hippo');
    mkdirSync(emptyRoot, { recursive: true });
    const early = dashboardOf(
      emptyRoot,
      () => clock,
      () => clock,
    );
    try {
      expect((await overview(false, early)).total).toBe(0);
      expect(existsSync(join(emptyRoot, 'hippo.db'))).toBe(false);
      seed(emptyRoot, 'now there is a row');
      clock += COALESCE_MS + 1;
      expect((await overview(false, early)).total).toBe(1);
    } finally {
      await early.reads.close();
    }
  });
});

describe('live population', () => {
  it('drops superseded, archived and quarantined rows and reports them in excluded', async () => {
    seed(store.hippoRoot, 'live one');
    seed(store.hippoRoot, 'live two', { layer: Layer.Trace });
    const successor = seed(store.hippoRoot, 'the replacement');
    seed(store.hippoRoot, 'replaced', { kind: 'superseded', supersededBy: successor.id });
    seed(store.hippoRoot, 'archived row', { kind: 'archived' });
    seed(store.hippoRoot, 'quarantined row', { scope: quarantineScopeFor(null) });
    // Quarantine wins over superseded, so this row is counted once, as quarantined.
    seed(store.hippoRoot, 'both', { kind: 'superseded', supersededBy: successor.id, scope: quarantineScopeFor('x') });

    const read = await overview();

    expect(read.total).toBe(3);
    expect(read.excluded).toEqual({ superseded: 1, archived: 1, quarantined: 2 });
  });
});

describe('vector coverage', () => {
  it('imports a legacy embeddings.json on the read and counts it in that same read', async () => {
    const row = seed(store.hippoRoot, 'a row');
    writeFileSync(join(store.hippoRoot, 'embeddings.json'), JSON.stringify({ [row.id]: [0.1, 0.2] }));

    const read = await overview();

    expect(read.embeddingCoverage).toBe(1);
    expect(existsSync(join(store.hippoRoot, 'embeddings.json'))).toBe(false);
  });

  it('counts no coverage for a corrupt legacy file and still answers the read', async () => {
    seed(store.hippoRoot, 'a row');
    writeFileSync(join(store.hippoRoot, 'embeddings.json'), '{not json');

    const read = await overview();

    expect(read.total).toBe(1);
    expect(read.embeddingCoverage).toBe(0);
    expect(existsSync(join(store.hippoRoot, 'embeddings.json'))).toBe(false);
    expect(readdirSync(store.hippoRoot).some((f) => f.startsWith('embeddings.json.corrupt-'))).toBe(true);
  });

  it('counts a vector write at once, and moves the id once the coalescing window has passed', async () => {
    const row = seed(store.hippoRoot, 'a row');
    const first = await overview();
    expect(first.embeddingCoverage).toBe(0);

    embed(store.hippoRoot, [row.id]);
    clock += COALESCE_MS - 1;
    const inside = await overview();
    expect(inside.snapshotId).toBe(first.snapshotId);
    expect(inside.embeddingCoverage).toBe(1);

    clock += 2;
    const after = await overview();
    expect(after.snapshotId).toBeGreaterThan(first.snapshotId);
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

  it('reads the detail embedded flag at each read, so a new vector shows inside the window', async () => {
    const target = seed(store.hippoRoot, 'embed me');
    await get(dash.port, '/api/overview?fresh=1');
    embed(store.hippoRoot, [target.id]);

    const inside = parse<MemoryDetail>(await get(dash.port, `/api/memory/${target.id}`));
    clock += COALESCE_MS + 1;
    const after = parse<MemoryDetail>(await get(dash.port, `/api/memory/${target.id}`));

    expect(inside.embedded).toBe(true);
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

  it('refuses a cross-site ?fresh=1 before it can force a rebuild, and honours a same-origin one', async () => {
    const first = parse<Overview>(await get(dash.port, '/api/overview'));
    seed(store.hippoRoot, 'written elsewhere');

    const crossSite = await call(dash.port, 'GET', '/api/overview?fresh=1', {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    const plain = parse<Overview>(await get(dash.port, '/api/overview'));
    const sameOrigin = parse<Overview>(
      await call(dash.port, 'GET', '/api/overview?fresh=1', { headers: { 'Sec-Fetch-Site': 'same-origin' } }),
    );

    expect(crossSite.status).toBe(403);
    expect(plain.snapshotId).toBe(first.snapshotId);
    expect(sameOrigin.snapshotId).toBeGreaterThan(first.snapshotId);
  });
});
