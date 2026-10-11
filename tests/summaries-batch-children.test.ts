import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { childrenKey, loadChildrenOfSummaries, loadChildrenOfSummary } from '../src/store/summaries.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';

describe('loadChildrenOfSummaries', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-children-batch-'));
    initStore(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('matches the per-summary read for more parents than one chunk', () => {
    const parents = Array.from({ length: 520 }, (_, i) => ({ id: `parent_${i}`, tenantId: 'default' }));
    for (const [i, p] of parents.entries()) {
      if (i % 3 === 2) continue; // childless parent
      writeEntry(root, createMemory(`child of ${p.id}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, dag_parent_id: p.id }));
    }
    const batched = loadChildrenOfSummaries(root, parents);
    for (const p of [parents[0], parents[2], parents[510], parents[519]]) {
      const single = loadChildrenOfSummary(root, p.id, p.tenantId).map((c) => c.id);
      expect((batched.get(childrenKey(p.tenantId, p.id)) ?? []).map((c) => c.id)).toEqual(single);
    }
    expect(batched.has(childrenKey('default', 'parent_2'))).toBe(false);
  });
});
