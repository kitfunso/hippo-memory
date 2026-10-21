// The Reports reads behind status and auto-sleep answer alike on hippo.db and on a store held in memory, over two tenants,
// superseded and raw rows, open and resolved conflicts, and a vector whose memory is gone.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { withSharedStoreHandles } from '../../src/db/index.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { listMemoryConflicts, writeEntry, updateStats } from '../_helpers/root-forms.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
  expectSameOutcomes,
} from '../_helpers/store-conformance.js';
import {
  replaceDetectedConflicts,
  appendConsolidationRun,
  resolveConflictKeeping,
  saveStoredVectors,
} from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const NOW = '2026-03-01T12:00:05.000Z';
const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();

let fixture: TwoTenantFixture;

function at(entry: MemoryEntry, iso: string): MemoryEntry {
  return { ...entry, created: iso, validFrom: iso, lastRetrieved: iso };
}

function seed(dir: string): void {
  const a = (content: string, iso: string, over: Parameters<typeof createMemory>[1] = {}): MemoryEntry =>
    at(createMemory(content, { tenantId: TENANT_A, ...over }), iso);
  const raw = a('slack: the tier moved to 120', ago(30 * 24 * HOUR), { kind: 'raw' });
  const newFact = a('belief: the tier is 120', ago(HOUR), { extractedFrom: raw.id, layer: Layer.Semantic });
  const oldFact = { ...a('belief: the tier is 100', ago(40 * 24 * HOUR)), supersededBy: newFact.id };
  const dangling = { ...a('belief: replaced by a deleted row', ago(20 * 24 * HOUR)), supersededBy: 'mem_gone' };
  const pinned = a('pinned: the deploy window is friday', ago(3 * HOUR), { pinned: true, confidence: 'verified' });
  const aged = a('an aged note about the old cluster', ago(2 * 24 * HOUR), { confidence: 'inferred' });
  const b = (content: string, iso: string): MemoryEntry => at(createMemory(content, { tenantId: TENANT_B }), iso);
  const recentB = b('tenant b: the invoice run is tuesday', ago(HOUR / 2));
  const olderB = b('tenant b: the old invoice run', ago(5 * HOUR));
  for (const e of [raw, newFact, oldFact, dangling, pinned, aged, recentB, olderB]) {
    writeEntry(dir, e, { actor: 'cli' });
  }
  replaceDetectedConflicts(
    dir,
    [
      { memory_a_id: pinned.id, memory_b_id: aged.id, reason: 'open', score: 0.9 },
      { memory_a_id: recentB.id, memory_b_id: olderB.id, reason: 'resolved below', score: 0.8 },
    ],
    NOW,
  );
  const resolved = listMemoryConflicts(dir).find((c) => c.reason === 'resolved below');
  if (!resolved) throw new Error('fixture conflict missing');
  resolveConflictKeeping(dir, TENANT_B, resolved.id, recentB.id);
  saveStoredVectors(
    dir,
    [
      [pinned.id, [1, 2, 3, 4]],
      ['orphan', [0, 1, 0, 1]],
    ],
    'm',
  );
  updateStats(dir, { remembered: 5, recalled: 3, forgotten: 1 });
  for (let i = 52; i >= 2; i--) {
    appendConsolidationRun(dir, { timestamp: ago(i * HOUR), decayed: i, merged: 0, removed: 1 });
  }
}

async function conforms<R>(calls: readonly GroupCall<'reports', R>[]) {
  const sides = await onBothStores(fixture, 'reports', calls);
  expectSameOutcomes(sides);
  return sides.sqlite.outcomes;
}

beforeAll(() =>
  withSharedStoreHandles(() => {
    fixture = seedTwoTenants();
    seed(fixture.dir);
  }),
);

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => vi.useRealTimers());

describe('Reports.stats', () => {
  it('returns the counters and the newest fifty sleep runs, oldest first', async () => {
    const [stats] = await conforms([(r) => r.stats()]);
    expect(stats).toMatchObject({ value: { total_remembered: 5, total_recalled: 3, total_forgotten: 1 } });
    const runs = 'value' in stats ? stats.value.consolidation_runs : null;
    expect(Array.isArray(runs) && runs.length).toBe(50);
    expect(Array.isArray(runs) && runs[0]).toEqual({ timestamp: ago(51 * HOUR), decayed: 51, merged: 0, removed: 1 });
  });
});

describe('Reports.statusCounts', () => {
  it('tallies every tenant and superseded rows, open conflicts and the vectors of live rows', async () => {
    const [low, high] = await conforms([
      (r) => r.statusCounts(new Date(NOW), 0.2),
      (r) => r.statusCounts(new Date(NOW), 0.99),
    ]);
    expect(low).toMatchObject({ value: { total: 8, pinned: 1, openConflicts: 1, embedded: 1 } });
    expect(high).not.toEqual(low);
  });
});

describe('Reports.correctionLinks and rawProvenance', () => {
  it('join each superseded row to a successor that exists and its source, and count the raw rows', async () => {
    const [links] = await conforms([(r) => r.correctionLinks({ limit: 500 })]);
    const [raw] = await conforms([(r) => r.rawProvenance({ limit: 500 })]);
    expect('value' in links && links.value.links.map((l) => [l.correctedAt, l.sourceCreated])).toEqual([
      [ago(HOUR), ago(30 * 24 * HOUR)],
    ]);
    expect('value' in raw && raw.value.total).toBe(1);
  });
});

describe('Reports.createdSinceLastSleep', () => {
  it('counts the tenant rows newer than the last run, a fresh write included, and at most a day back', async () => {
    const fresh = createMemory('a fresh note written through the port', { tenantId: TENANT_A });
    const counts = await conforms([
      (r) => r.createdSinceLastSleep(TENANT_A, new Date(NOW)),
      (r) => r.createdSinceLastSleep(TENANT_B, new Date(NOW)),
      async (r, store) => {
        await store.entryWrites.writeEntry({ entry: structuredClone(fresh), actor: 'cli' });
        return r.createdSinceLastSleep(TENANT_A, new Date(NOW));
      },
      (r) => r.createdSinceLastSleep(TENANT_A, new Date(Date.parse(NOW) + 25 * HOUR)),
    ]);
    expect(counts).toEqual([{ value: 1 }, { value: 1 }, { value: 2 }, { value: 0 }]);
  });
});
