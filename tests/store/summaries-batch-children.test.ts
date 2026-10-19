import { describe, it, expect, beforeEach } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntriesTogether, loadChildrenOfSummary } from '../_helpers/root-forms.js';

describe('childrenOfSummaries', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('children-batch');
  });

  it('matches the per-summary read for more parents than one chunk', () => {
    const parents = Array.from({ length: 520 }, (_, i) => ({ id: `parent_${i}`, tenantId: 'default' }));
    const entries = parents
      .filter((_, i) => i % 3 !== 2) // every third parent stays childless
      .map((p) => createMemory(`child of ${p.id}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, dagParentId: p.id }));
    writeEntriesTogether(root, entries);
    const childrenOf = sqliteSyncStore(root).localFiles.consolidation.childrenOfSummaries(parents);
    for (const p of [parents[0], parents[2], parents[510], parents[519]]) {
      const single = loadChildrenOfSummary(root, p.id, p.tenantId).map((c) => c.id);
      expect(childrenOf(p).map((c) => c.id)).toEqual(single);
    }
    expect(childrenOf(parents[2])).toEqual([]);
  });
});
