// A dashboard write that committed answers 200 even when the next snapshot rebuild would fail; the next read is where it surfaces.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as dashboardReads from '../src/store/dashboard-reads.js';
import * as entryReads from '../src/store/entry-reads.js';
import type { MemoryDetail, Overview } from '../src/dashboard/dashboard-types.js';
import {
  DASHBOARD_TOKEN, NOW, get, makeStore, parse, postJson, seed, startDashboard, type RunningDashboard, type TmpStore,
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

/** Makes every snapshot build throw, because `loadDashboardRows` is the one store call only a build makes. */
function breakSnapshotRebuild(): void {
  vi.spyOn(dashboardReads, 'loadDashboardRows').mockImplementation(() => {
    throw new Error('forced rebuild failure');
  });
}

describe('a failing API request that carries the access token', () => {
  it('logs the bare path and never the token', async () => {
    breakSnapshotRebuild();
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const reply = await get(dash.port, `/api/overview?token=${DASHBOARD_TOKEN}`);

    const failure = written.filter((line) => line.includes('dashboard request failed'));
    expect(reply.status).toBe(500);
    expect(failure.length).toBeGreaterThan(0);
    expect(written.some((line) => line.includes(DASHBOARD_TOKEN))).toBe(false);
    expect(failure.some((line) => /path=\S*\/api\/overview(\s|$)/.test(line))).toBe(true);
  });
});

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
