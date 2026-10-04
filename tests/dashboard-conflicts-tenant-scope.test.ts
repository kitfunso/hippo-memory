// The overview's open-conflict count and a memory's conflicts follow HIPPO_TENANT, like the memory list.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeEntry } from '../src/store/entry-writes.js';
import * as conflicts from '../src/store/conflicts.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import type { MemoryDetail, Overview } from '../src/dashboard-types.js';
import { get, makeStore, parse, startDashboard, type RunningDashboard, type TmpStore } from './_helpers/dashboard-fixture.js';

let tmp: TmpStore;
let dash: RunningDashboard;

function seedTwoTenants() {
  const a1 = createMemory('tenant_a says the deploy target is fly', { tenantId: 'tenant_a' });
  const a2 = createMemory('tenant_a says the deploy target is render', { tenantId: 'tenant_a' });
  const b1 = createMemory('tenant_b says the build uses webpack', { tenantId: 'tenant_b' });
  const b2 = createMemory('tenant_b says the build uses vite', { tenantId: 'tenant_b' });
  for (const m of [a1, a2, b1, b2]) writeEntry(tmp.hippoRoot, m);
  conflicts.replaceDetectedConflicts(tmp.hippoRoot, [
    { memory_a_id: a1.id, memory_b_id: a2.id, reason: 'deploy target', score: 0.9 },
    { memory_a_id: b1.id, memory_b_id: b2.id, reason: 'build tool', score: 0.8 },
  ]);
  return { a1, a2, b1 };
}

beforeEach(async () => {
  tmp = makeStore('hippo-dash-conflicts');
  process.env.HIPPO_TENANT = 'tenant_a';
  dash = await startDashboard(tmp.hippoRoot, () => Date.now());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dash.close();
  tmp.cleanup();
});

describe('dashboard conflicts are tenant-scoped', () => {
  it('the overview and the memory detail count only the running tenant', async () => {
    const { a1, a2, b1 } = seedTwoTenants();

    const overview = await get(dash.port, '/api/overview');
    expect(overview.status).toBe(200);
    const parsed = parse<Overview>(overview);
    expect(parsed.total).toBe(2);
    expect(parsed.kpis.find((k) => k.id === 'openConflicts')?.value).toBe(1);

    const detail = await get(dash.port, `/api/memory/${a1.id}`);
    expect(detail.status).toBe(200);
    const own = parse<MemoryDetail>(detail);
    expect(own.conflicts.map((c) => c.reason)).toEqual(['deploy target']);
    expect(own.conflicts[0].other.id).toBe(a2.id);

    expect((await get(dash.port, `/api/memory/${b1.id}`)).status).toBe(404);
  }, 15_000);

  it('passes the running tenant to every conflict load, so later filters are not the only guard', async () => {
    const { a1 } = seedTwoTenants();
    const load = vi.spyOn(conflicts, 'listMemoryConflicts');

    await get(dash.port, '/api/overview');
    expect(load).toHaveBeenCalled();
    expect(load.mock.calls.every(([, , tenantId]) => tenantId === 'tenant_a')).toBe(true);

    load.mockClear();
    await get(dash.port, `/api/memory/${a1.id}`);
    expect(load).toHaveBeenCalled();
    expect(load.mock.calls.every(([, , tenantId]) => tenantId === 'tenant_a')).toBe(true);
  }, 15_000);
});
