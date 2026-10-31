import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { Layer } from '../../src/base/memory/entry.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether, loadChildrenOfSummary } from '../_helpers/root-forms.js';

describe('dirtySummaries children', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('children-batch');
  });

  it('matches the per-summary read for more parents than one chunk', async () => {
    const at = { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS };
    const parents = Array.from({ length: 520 }, (_, i) => ({
      ...createMemory(`parent ${i}`, { ...at, layer: Layer.Semantic, dagLevel: 2, tags: ['dag-summary'] }),
      id: `parent_${i}`,
    }));
    const entries = parents
      .filter((_, i) => i % 3 !== 2) // every third parent stays childless
      .map((p) => createMemory(`child of ${p.id}`, { ...at, dagParentId: p.id }));
    writeEntriesTogether(root, [...parents, ...entries]);
    const db = openHippoDb(root);
    try {
      db.prepare('UPDATE memories SET summary_dirty = 1 WHERE dag_level = 2').run();
    } finally {
      closeHippoDb(db);
    }
    const dirty = await sqliteStore(root).hippoDb.consolidation.dirtySummaries(parents.length);
    expect(dirty.summaries).toHaveLength(parents.length);
    expect(dirty.more).toBe(false);
    const childrenOf = new Map(dirty.summaries.map((s) => [s.summary.id, s.children.map((c) => c.id)]));
    for (const index of [0, 2, 510, 519]) {
      const p = parents[index]!;
      const single = (await loadChildrenOfSummary(root, p.id, p.tenantId)).map((c) => c.id);
      expect(childrenOf.get(p.id)).toEqual(single);
    }
    expect(childrenOf.get('parent_2')).toEqual([]);
    expect(childrenOf.get('parent_0')).toHaveLength(1);
  });
});
