import { describe, it, expect, beforeEach } from 'vitest';
import { writeEntriesTogether } from '../src/store/entry-writes.js';
import { childrenKey, loadChildrenOfSummaries, loadChildrenOfSummary } from '../src/store/summaries.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { makeRoot } from './_helpers/make-root.js';

describe('loadChildrenOfSummaries', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('children-batch');
  });

  it('matches the per-summary read for more parents than one chunk', () => {
    const parents = Array.from({ length: 520 }, (_, i) => ({ id: `parent_${i}`, tenant_id: 'default' }));
    const entries = parents
      .filter((_, i) => i % 3 !== 2) // every third parent stays childless
      .map((p) => createMemory(`child of ${p.id}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, dagParentId: p.id }));
    writeEntriesTogether(root, entries);
    const batched = loadChildrenOfSummaries(root, parents);
    for (const p of [parents[0], parents[2], parents[510], parents[519]]) {
      const single = loadChildrenOfSummary(root, p.id, p.tenant_id).map((c) => c.id);
      expect((batched.get(childrenKey(p.tenant_id, p.id)) ?? []).map((c) => c.id)).toEqual(single);
    }
    expect(batched.has(childrenKey('default', 'parent_2'))).toBe(false);
  });
});
