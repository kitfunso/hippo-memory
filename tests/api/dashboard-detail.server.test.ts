// The api functions the dashboard's reader thread runs: a memory's detail, and the detail after a dashboard write.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminActor, memoryPin } from '../../src/api/index.js';
import { dashboardDetailAfterWrite, dashboardMemoryDetail } from '../../src/api/dashboard/detail.js';
import type { SnapshotService } from '../../src/api/dashboard/snapshot.js';
import * as conflicts from '../../src/store/sqlite/conflicts.js';
import { apiCtx, type FullContext } from '../_helpers/api-ctx.js';
import { NOW, makeStore, seed, snapshotsOf, type TmpStore } from '../_helpers/dashboard-fixture.js';

let store: TmpStore;
let ctx: FullContext;
let snapshots: SnapshotService;
const at = { fresh: false, nowMs: NOW };

beforeEach(() => {
  store = makeStore('hippo-dash-detail');
  ctx = apiCtx(store.hippoRoot, 'default', adminActor('dashboard'));
  snapshots = snapshotsOf(store.hippoRoot, () => NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  snapshots.close();
  store.cleanup();
});

describe('dashboardMemoryDetail', () => {
  it("answers a live memory's detail, stamped with the snapshot the client holds", async () => {
    const live = seed(store.hippoRoot, 'a live fact', { tags: ['ops'] });
    const held = snapshots.get('default').id;

    const detail = await dashboardMemoryDetail(ctx, snapshots, live.id, at);

    expect(detail).toMatchObject({ id: live.id, content: 'a live fact', tags: ['ops'], snapshotId: held });
  });

  it('answers null for a superseded row, another tenant row and a missing id', async () => {
    const live = seed(store.hippoRoot, 'the replacement');
    const old = seed(store.hippoRoot, 'replaced', { kind: 'superseded', supersededBy: live.id });
    const other = seed(store.hippoRoot, 'theirs', { tenantId: 'tenant_b' });

    for (const id of [old.id, other.id, 'mem_missing']) {
      expect(await dashboardMemoryDetail(ctx, snapshots, id, at)).toBeNull();
    }
  });

  it('rebuilds the snapshot first when the read is fresh', async () => {
    const live = seed(store.hippoRoot, 'a live fact');
    const held = snapshots.get('default').id;

    const detail = await dashboardMemoryDetail(ctx, snapshots, live.id, { fresh: true, nowMs: NOW });

    expect(detail!.snapshotId).toBeGreaterThan(held);
  });
});

describe('dashboardDetailAfterWrite', () => {
  it('drops the snapshot after a committed write, so the next read rebuilds', async () => {
    seed(store.hippoRoot, 'a live fact');
    const held = snapshots.get('default').id;

    expect(await dashboardDetailAfterWrite(ctx, snapshots, { changed: true }, NOW)).toBeNull();

    expect(snapshots.get('default').id).toBeGreaterThan(held);
  });

  it('keeps the snapshot when nothing committed', async () => {
    seed(store.hippoRoot, 'a live fact');
    const held = snapshots.get('default').id;

    await dashboardDetailAfterWrite(ctx, snapshots, { changed: false }, NOW);

    expect(snapshots.get('default').id).toBe(held);
  });

  it('answers the pinned detail stamped with the last build while a rebuild would fail, which the next read reports', async () => {
    const target = seed(store.hippoRoot, 'pin me');
    const held = snapshots.get('default').id;
    // Every build pages the open conflicts; no write and no detail read does.
    vi.spyOn(conflicts, 'conflictPageAt').mockImplementation(() => {
      throw new Error('forced rebuild failure');
    });

    const entry = await memoryPin(ctx, target.id, true);
    const detail = await dashboardDetailAfterWrite(ctx, snapshots, { changed: true, entry }, NOW);

    expect(detail).toMatchObject({ id: target.id, pinned: true, band: 'pinned', snapshotId: held });
    expect(() => snapshots.get('default')).toThrow('forced rebuild failure');
  });
});
