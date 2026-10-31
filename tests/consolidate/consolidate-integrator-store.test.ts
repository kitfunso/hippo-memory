// consolidate() handed an integrator's store changes that store, never the folder a path form or the environment names.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { consolidate, sleep } from '../../src/index.js';
import type { HippoStore } from '../../src/entry/store-kit.js';
import { NoLocalTierError } from '../../src/base/util/store-blocked.js';
import { loadConfig } from '../../src/host/config-file.js';
import { portOnlyStore } from '../_helpers/port-only-store.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../../src/entry/memory.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { openHippoDb, closeHippoDb, ftsRowCounts, type DatabaseSyncLike } from '../../src/db/index.js';
import { makeStore } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { detailLines } from '../_helpers/sleep-lines.js';

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

describe("consolidate on an integrator store with hippo.db's local tier", () => {
  it("repairs the integrator's store and leaves another folder's drift alone", async () => {
    const store: HippoStore = { ...sqliteStore(b) };

    const result = await consolidate(store);

    expect(detailLines(result).some((line) => line.includes('re-synced the full-text index'))).toBe(true);
    expect(withDb(b, ftsRowCounts)).toEqual({ memories: 1, fts: 1 });
    expect(withDb(a, ftsRowCounts)).toEqual({ memories: 1, fts: 0 });
  });

  it('the path form still repairs the folder it names', async () => {
    await consolidate(a);

    expect(withDb(a, ftsRowCounts)).toEqual({ memories: 1, fts: 1 });
    expect(withDb(b, ftsRowCounts)).toEqual({ memories: 1, fts: 0 });
  });

  it('consolidate and sleep reject a store without the local tier before any pass runs', async () => {
    const store = portOnlyStore(b);
    await expect(consolidate(store)).rejects.toBeInstanceOf(NoLocalTierError);
    const ctx = {
      store,
      config: loadConfig(b),
      tenantId: 'default',
      actor: { subject: 'cli', role: 'admin' as const },
    };
    await expect(sleep(ctx)).rejects.toBeInstanceOf(NoLocalTierError);
    expect(withDb(b, ftsRowCounts)).toEqual({ memories: 1, fts: 0 });
  });
});
