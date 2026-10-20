import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether, loadChildrenOfSummary } from '../_helpers/root-forms.js';

describe('childrenOfSummaries', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('children-batch');
  });

  it('matches the per-summary read for more parents than one chunk', async () => {
    const parents = Array.from({ length: 520 }, (_, i) => ({ id: `parent_${i}`, tenantId: 'default' }));
    const entries = parents
      .filter((_, i) => i % 3 !== 2) // every third parent stays childless
      .map((p) => createMemory(`child of ${p.id}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, dagParentId: p.id }));
    writeEntriesTogether(root, entries);
    const childrenOf = await sqliteStore(root).consolidation.childrenOfSummaries(parents);
    expect(childrenOf).toHaveLength(parents.length);
    for (const at of [0, 2, 510, 519]) {
      const p = parents[at];
      const single = loadChildrenOfSummary(root, p.id, p.tenantId).map((c) => c.id);
      expect(childrenOf[at].map((c) => c.id)).toEqual(single);
    }
    expect(childrenOf[2]).toEqual([]);
  });
});
