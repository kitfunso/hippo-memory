// Invalidation, the dirty-summary queue and the store count read only the rows they need: counted in rows, never timed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';
import { makeRoot } from '../_helpers/make-root.js';
import { memoryRows } from '../_helpers/seed-rows.js';
import { recordStatementsAsync } from '../_helpers/count-statements.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { invalidateMatching } from '../../src/domain/learn/invalidation.js';
import { rebuildDirtySummaries } from '../../src/domain/consolidate/dag.js';
import { memoryCountAll } from '../../src/api/memories/memories.js';
import { adminActor } from '../../src/api/types.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { writeEntriesTogether, loadAllDirtySummaries, loadAllEntries } from '../_helpers/root-forms.js';
import { loadConfig } from '../../src/base/config/config.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) removeAfterRequest(r);
});

function newRoot(label: string): string {
  const root = makeRoot(label);
  roots.push(root);
  return root;
}

function memory(content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra };
}

function padding(n: number): MemoryEntry[] {
  return memoryRows(n, (i) => `unrelated note ${i} about the deploy scripts`);
}

describe('invalidateMatching without onlyId', () => {
  const target = { from: 'zephyrine cache', to: null, type: 'removal' as const };

  function seededForInvalidation(n: number) {
    const root = newRoot('bounded-invalidate');
    const hits = {
      half: memory('the Zephyrine layer is slow'),
      tagOnly: memory('nothing in the text', { tags: ['Zephyrine Cache'] }),
      pinned: memory('pinned zephyrine cache note', { pinned: true }),
    };
    const misses = [memory('zephyrines and caches differ'), memory('acme zephyrine cache', { tenantId: 'acme' })];
    writeEntriesTogether(root, [...padding(n), ...Object.values(hits), ...misses]);
    return { root, hits };
  }

  it('weakens the same rows a pass over every row would, in the same order', async () => {
    const { root, hits } = seededForInvalidation(50);
    const expected = new Set([hits.half.id, hits.tagOnly.id]);
    const order = loadAllEntries(root, 'default')
      .map((e) => e.id)
      .filter((id) => expected.has(id));
    const result = await invalidateMatching(sqliteStore(root), target, 'default');
    expect(result.targets).toEqual(order);
    expect(result.skippedPinned).toEqual([hits.pinned.id]);
    const after = loadAllEntries(root, 'default')
      .filter((e) => e.tags.includes('invalidated'))
      .map((e) => e.id)
      .sort();
    expect(after).toEqual([...expected].sort());
  });

  it('still finds content whose lowercase only reaches ASCII outside SQLite folding', async () => {
    const root = newRoot('bounded-invalidate-fold');
    const kelvin = memory('Kappa value drifted');
    writeEntriesTogether(root, [...padding(5), kelvin]);
    expect(
      (
        await invalidateMatching(sqliteStore(root), { from: 'kappa', to: null, type: 'removal' }, 'default', {
          dryRun: true,
        })
      ).targets,
    ).toEqual([kelvin.id]);
  });

  it('reads the same rows however many rows cannot match', async () => {
    const read: number[] = [];
    for (const n of [10, 200]) {
      const { root } = seededForInvalidation(n);
      const { rowsRead } = await recordStatementsAsync(() =>
        invalidateMatching(sqliteStore(root), target, 'default', { dryRun: true }),
      );
      read.push(rowsRead);
    }
    expect(read[1]).toBe(read[0]);
  });
});

describe('rebuildDirtySummaries', () => {
  function seededDirty(n: number): string {
    const root = newRoot('bounded-dirty');
    const summaries = Array.from({ length: n }, (_, i) => ({
      ...createMemory(`summary ${i}`, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Semantic,
        tags: ['dag-summary'],
        dagLevel: 2,
      }),
      latestAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }));
    writeEntriesTogether(root, summaries);
    const db = openHippoDb(root);
    try {
      db.prepare('UPDATE memories SET summary_dirty = 1 WHERE dag_level = 2').run();
    } finally {
      closeHippoDb(db);
    }
    return root;
  }

  it('takes the newest dirty summaries first and reads one past the cap', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }));
    const read: number[] = [];
    for (const n of [10, 60]) {
      const root = seededDirty(n);
      const newest = (await loadAllDirtySummaries(root)).slice(0, 3).map((e) => e.id);
      expect((await loadAllDirtySummaries(root, 3)).map((e) => e.id)).toEqual(newest);
      const { result, rowsRead } = await recordStatementsAsync(() =>
        rebuildDirtySummaries(sqliteStore(root), { llm: anthropicLlm({ apiKey: 'k', fetcher }), cap: 2 }),
      );
      expect(result).toMatchObject({ attempted: 2, capped: true });
      read.push(rowsRead);
    }
    expect(read[1]).toBe(read[0]);
  });
});

describe('memoryCountAll', () => {
  it("counts every tenant's rows without reading them", async () => {
    const read: number[] = [];
    for (const n of [10, 200]) {
      const root = newRoot('bounded-count');
      writeEntriesTogether(root, [...padding(n), memory('acme row', { tenantId: 'acme' })]);
      const ctx = {
        hippoRoot: root,
        tenantId: 'default',
        actor: adminActor('test:count'),
        store: sqliteStore(root),
        config: loadConfig(root),
      };
      const { result, rowsRead } = await recordStatementsAsync(() => memoryCountAll(ctx));
      expect(result).toBe(n + 1);
      read.push(rowsRead);
    }
    expect(read[1]).toBe(read[0]);
  });
});
