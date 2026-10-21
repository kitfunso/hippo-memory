// HIPPO_LOSS_AVERSION_RATIO reaches the dashboard: its listener and reader thread are roots that read the ratio, so
// the memory page (built from the snapshot) and the drawer (read fresh) score a negative memory by it.
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { MemoryDetail, MemoryPage } from '../../src/api/dashboard/types.js';
import { get, isoAgo, makeStore, parse, seed, startDashboard } from '../_helpers/dashboard-fixture.js';

// Faded enough that the negative multiplier stays under the 1.0 clamp, so the ratio shows in the strength.
const FADED_NEGATIVE = {
  halfLifeDays: 10,
  created: isoAgo(30),
  lastRetrieved: isoAgo(30),
  emotionalValence: 'negative',
} as const;

async function strengthsUnder(ratio: string | undefined): Promise<{ page: number; drawer: number }> {
  vi.stubEnv('HIPPO_LOSS_AVERSION_RATIO', ratio);
  const store = makeStore('dash-ratio');
  const entry = seed(store.hippoRoot, 'the deploy broke prod', FADED_NEGATIVE);
  const dash = await startDashboard(store.hippoRoot);
  try {
    const page = await get(dash.port, `/api/projects/${encodeURIComponent('p:alpha')}/memories`);
    const drawer = await get(dash.port, `/api/memory/${entry.id}`);
    expect([page.status, drawer.status]).toEqual([200, 200]);
    const row = parse<MemoryPage>(page).rows.find((r) => r.id === entry.id);
    return { page: row?.strength ?? Number.NaN, drawer: parse<MemoryDetail>(drawer).strength };
  } finally {
    await dash.close();
    store.cleanup();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the dashboard scores strength by the ratio its roots read', () => {
  it('halves a negative memory at ratio 0.5, on the memory page and in the drawer', async () => {
    const unset = await strengthsUnder(undefined);
    const halved = await strengthsUnder('0.5');
    expect(unset.page).toBeGreaterThan(0);
    expect(unset.drawer).toBeCloseTo(unset.page, 2);
    expect(halved.page).toBeCloseTo(unset.page / 2, 2);
    expect(halved.drawer).toBeCloseTo(unset.drawer / 2, 2);
  });
});
