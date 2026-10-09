// A dashboard write that committed answers 200 even when the next snapshot rebuild would fail; the next read is where it surfaces.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as entryReads from '../src/store/entry-reads.js';
import type { MemoryDetail, Overview } from '../src/dashboard/dashboard-types.js';
import {
  NOW, get, makeStore, parse, postJson, seed, startDashboard, type RunningDashboard, type TmpStore,
} from './_helpers/dashboard-fixture.js';

let store: TmpStore;
let dash: RunningDashboard;

beforeEach(async () => {
  store = makeStore('hippo-dash-rebuild-fail');
  dash = await startDashboard(store.hippoRoot, () => NOW);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dash.close();
  store.cleanup();
});

/** Makes every snapshot build throw, because `loadAllEntries` is the one store call only a build makes. */
function breakSnapshotRebuild(): void {
  vi.spyOn(entryReads, 'loadAllEntries').mockImplementation(() => {
    throw new Error('forced rebuild failure');
  });
}

describe('pin while the snapshot rebuild fails', () => {
  it('answers 200, persists the pin, and leaves the failure to the next read', async () => {
    const target = seed(store.hippoRoot, 'pin me');
    const before = parse<Overview>(await get(dash.port, '/api/overview'));
    breakSnapshotRebuild();

    const pinned = await postJson(dash.port, `/api/memory/${target.id}/pin`, { pinned: true });

    expect(pinned.status).toBe(200);
    expect(parse<MemoryDetail>(pinned).pinned).toBe(true);
    expect(parse<MemoryDetail>(pinned).snapshotId).toBe(before.snapshotId);
    expect(entryReads.readEntry(store.hippoRoot, target.id)!.pinned).toBe(true);
    expect((await get(dash.port, '/api/overview')).status).toBe(500);
  });
});
