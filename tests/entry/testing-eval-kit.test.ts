// The eval kit hippo-memory/testing publishes: an eval seeds a store folder, then scores what it reads back from it.
import { describe, expect, it } from 'vitest';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/core/memory.js';
import { initStore, loadAllEntries, writeEntry } from '../../src/entry/testing.js';
import { makeRoot } from '../_helpers/make-root.js';

describe('the hippo-memory/testing eval kit', () => {
  it("reads back every tenant's rows from a folder it set up", () => {
    const root = makeRoot('eval-kit', { init: false });
    initStore(root);
    expect(loadAllEntries(root)).toEqual([]);

    const mine = createMemory('default tenant note about the kestrel deploy', {
      tenantId: 'default',
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    const theirs = createMemory('acme tenant note about the kestrel deploy', {
      tenantId: 'acme',
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });
    writeEntry(root, mine);
    writeEntry(root, theirs);

    const rows = loadAllEntries(root).map((e) => [e.id, e.tenantId]);
    expect(rows).toEqual(
      expect.arrayContaining([
        [mine.id, 'default'],
        [theirs.id, 'acme'],
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});
