// The api functions the dashboard's reader thread runs: a memory's detail, and the detail after a dashboard write.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminActor, memoryPin } from '../../src/api/index.js';
import { dashboardDetailAfterWrite, dashboardMemoryDetail } from '../../src/api/dashboard/detail.js';
import { apiCtx, type FullContext } from '../_helpers/api-ctx.js';
import { NOW, dashboardOf, makeStore, seed, type DashboardView, type TmpStore } from '../_helpers/dashboard-fixture.js';

let store: TmpStore;
let ctx: FullContext;
let view: DashboardView;
const at = { fresh: false, nowMs: NOW };

beforeEach(() => {
  store = makeStore('hippo-dash-detail');
  ctx = apiCtx(store.hippoRoot, 'default', adminActor('dashboard'));
  view = dashboardOf(store.hippoRoot, () => NOW);
});

afterEach(async () => {
  await view.reads.close();
  store.cleanup();
});

const heldId = async (): Promise<number> => (await view.clock.at('default')).id;

describe('dashboardMemoryDetail', () => {
  it("answers a live memory's detail, stamped with the snapshot id the client holds", async () => {
    const live = seed(store.hippoRoot, 'a live fact', { tags: ['ops'] });
    const held = await heldId();

    const detail = await dashboardMemoryDetail(ctx, view, live.id, at);

    expect(detail).toMatchObject({ id: live.id, content: 'a live fact', tags: ['ops'], snapshotId: held });
  });

  it('answers null for a superseded row, another tenant row and a missing id', async () => {
    const live = seed(store.hippoRoot, 'the replacement');
    const old = seed(store.hippoRoot, 'replaced', { kind: 'superseded', supersededBy: live.id });
    const other = seed(store.hippoRoot, 'theirs', { tenantId: 'tenant_b' });

    for (const id of [old.id, other.id, 'mem_missing']) {
      expect(await dashboardMemoryDetail(ctx, view, id, at)).toBeNull();
    }
  });

  it('takes a new snapshot id first when the read is fresh', async () => {
    const live = seed(store.hippoRoot, 'a live fact');
    const held = await heldId();

    const detail = await dashboardMemoryDetail(ctx, view, live.id, { fresh: true, nowMs: NOW });

    expect(detail!.snapshotId).toBeGreaterThan(held);
  });
});

describe('dashboardDetailAfterWrite', () => {
  it('drops the held id after a committed write, so the next read takes a new one', async () => {
    seed(store.hippoRoot, 'a live fact');
    const held = await heldId();

    expect(await dashboardDetailAfterWrite(ctx, view, { changed: true }, NOW)).toBeNull();

    expect(await heldId()).toBeGreaterThan(held);
  });

  it('keeps the held id when nothing committed', async () => {
    seed(store.hippoRoot, 'a live fact');
    const held = await heldId();

    await dashboardDetailAfterWrite(ctx, view, { changed: false }, NOW);

    expect(await heldId()).toBe(held);
  });

  it('answers the pinned detail stamped with the last id issued, which the next read moves past', async () => {
    const target = seed(store.hippoRoot, 'pin me');
    const held = await heldId();

    const entry = await memoryPin(ctx, target.id, true);
    const detail = await dashboardDetailAfterWrite(ctx, view, { changed: true, entry }, NOW);

    expect(detail).toMatchObject({ id: target.id, pinned: true, band: 'pinned', snapshotId: held });
    expect(await heldId()).toBeGreaterThan(held);
  });
});
