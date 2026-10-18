// Invalidation, the dirty-summary queue and the store count read only the rows they need: counted in rows, never timed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { makeRoot } from '../_helpers/make-root.js';
import { recordStatements, recordStatementsAsync } from '../_helpers/count-statements.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../../src/core/memory.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { openHippoDb } from '../../src/db/index.js';
import { invalidateMatching } from '../../src/learn/invalidation.js';
import { rebuildDirtySummaries } from '../../src/consolidate/dag.js';
import { countAllMemories } from '../../src/api/memories/memories.js';
import { adminActor } from '../../src/api/types.js';
import { sqliteStore, sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { sqliteConsolidation } from '../../src/store/sqlite/consolidation-group.js';
import { writeEntriesTogether, loadAllDirtySummaries } from '../_helpers/root-forms.js';
import { handlesOf } from '../../src/store/open.js';
import { loadConfig } from '../../src/core/config.js';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
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
  return Array.from({ length: n }, (_, i) => memory(`unrelated note ${i} about the deploy scripts`));
}

describe('invalidateMatching without onlyId', () => {
  const target = { from: 'zephyrine cache', to: null, type: 'removal' as const };

  function seeded(n: number) {
    const root = newRoot('bounded-invalidate');
    const hits = {
      half: memory('the Zephyrine layer is slow'),
      tagOnly: memory('nothing in the text', { tags: ['Zephyrine Cache'] }),
      pinned: memory('pinned zephyrine cache note', { pinned: true }),
    };
    const misses = [memory('zephyrines and caches differ'), memory('acme zephyrine cache', { tenant_id: 'acme' })];
    writeEntriesTogether(root, [...padding(n), ...Object.values(hits), ...misses]);
    return { root, hits };
  }

  it('weakens the same rows a pass over every row would, in the same order', () => {
    const { root, hits } = seeded(50);
    const expected = new Set([hits.half.id, hits.tagOnly.id]);
    const order = loadAllEntries(root, 'default').map((e) => e.id).filter((id) => expected.has(id));
    const result = invalidateMatching(sqliteSyncStore(root).localFiles.learning, target, 'default');
    expect(result.targets).toEqual(order);
    expect(result.skippedPinned).toEqual([hits.pinned.id]);
    const after = loadAllEntries(root, 'default').filter((e) => e.tags.includes('invalidated')).map((e) => e.id).sort();
    expect(after).toEqual([...expected].sort());
  });

  it('still finds content whose lowercase only reaches ASCII outside SQLite folding', () => {
    const root = newRoot('bounded-invalidate-fold');
    const kelvin = memory('Kappa value drifted');
    writeEntriesTogether(root, [...padding(5), kelvin]);
    expect(invalidateMatching(sqliteSyncStore(root).localFiles.learning, { from: 'kappa', to: null, type: 'removal' }, 'default', { dryRun: true }).targets).toEqual([kelvin.id]);
  });

  it('reads the same rows however many rows cannot match', () => {
    const read = [10, 200].map((n) => {
      const { root } = seeded(n);
      return recordStatements(() => invalidateMatching(sqliteSyncStore(root).localFiles.learning, target, 'default', { dryRun: true })).rowsRead;
    });
    expect(read[1]).toBe(read[0]);
  });
});

describe('rebuildDirtySummaries', () => {
  function seededDirty(n: number): string {
    const root = newRoot('bounded-dirty');
    const summaries = Array.from({ length: n }, (_, i) => ({
      ...createMemory(`summary ${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Semantic, tags: ['dag-summary'], dagLevel: 2 }),
      latest_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }));
    writeEntriesTogether(root, summaries);
    const db = openHippoDb(root);
    try {
      db.prepare('UPDATE memories SET summary_dirty = 1 WHERE dag_level = 2').run();
    } finally {
      db.close();
    }
    return root;
  }

  it('takes the newest dirty summaries first and reads one past the cap', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }));
    const read: number[] = [];
    for (const n of [10, 60]) {
      const root = seededDirty(n);
      const newest = loadAllDirtySummaries(root).slice(0, 3).map((e) => e.id);
      expect(loadAllDirtySummaries(root, 3).map((e) => e.id)).toEqual(newest);
      const { result, rowsRead } = await recordStatementsAsync(() => rebuildDirtySummaries(sqliteConsolidation(handlesOf(root)), { apiKey: 'k', fetcher, cap: 2 }));
      expect(result).toMatchObject({ attempted: 2, capped: true });
      read.push(rowsRead);
    }
    expect(read[1]).toBe(read[0]);
  });
});

describe('countAllMemories', () => {
  it('counts every tenant\'s rows without reading them', async () => {
    const read: number[] = [];
    for (const n of [10, 200]) {
      const root = newRoot('bounded-count');
      writeEntriesTogether(root, [...padding(n), memory('acme row', { tenant_id: 'acme' })]);
      const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test:count'), store: sqliteStore(root), config: loadConfig(root) };
      const { result, rowsRead } = await recordStatementsAsync(() => countAllMemories(ctx));
      expect(result).toBe(n + 1);
      read.push(rowsRead);
    }
    expect(read[1]).toBe(read[0]);
  });
});
