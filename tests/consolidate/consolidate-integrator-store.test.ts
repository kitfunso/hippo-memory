// consolidate() handed an integrator's store changes that store, never the folder a path form or the environment names.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { consolidate } from '../../src/index.js';
import type { LocalStore } from '../../src/store/local/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { openHippoDb, closeHippoDb, ftsRowCounts, type DatabaseSyncLike } from '../../src/db/index.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

let a: string;
let b: string;

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** One memory whose full-text row is gone, the drift a sleep repairs. */
function seedDrift(root: string): void {
  writeEntry(
    root,
    createMemory('the walrus build cache clears on tuesdays', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
  );
  withDb(root, (db) => db.prepare(`DELETE FROM memories_fts WHERE content LIKE '%walrus%'`).run());
}

beforeEach(() => {
  let base: string;
  ({ base, root: a } = makeStore('consolidate-store-a'));
  ({ root: b } = makeStore('consolidate-store-b'));
  vi.stubEnv('HIPPO_HOME', path.join(base, 'global'));
  seedDrift(a);
  seedDrift(b);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('consolidate on an integrator store with local files', () => {
  it("repairs the integrator's store and leaves another folder's drift alone", async () => {
    const store: LocalStore = { ...sqliteStore(b) };

    const result = await consolidate(store);

    expect(result.details.some((line) => line.includes('re-synced the full-text index'))).toBe(true);
    expect(withDb(b, ftsRowCounts)).toEqual({ memories: 1, fts: 1 });
    expect(withDb(a, ftsRowCounts)).toEqual({ memories: 1, fts: 0 });
  });

  it('the path form still repairs the folder it names', async () => {
    await consolidate(a);

    expect(withDb(a, ftsRowCounts)).toEqual({ memories: 1, fts: 1 });
    expect(withDb(b, ftsRowCounts)).toEqual({ memories: 1, fts: 0 });
  });
});
