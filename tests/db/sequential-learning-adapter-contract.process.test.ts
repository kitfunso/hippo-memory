import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSyncLike } from '../../src/db/index.js';
import { createAdapter } from '../../benchmarks/sequential-learning/adapters/interface.mjs';
import hippoAdapter from '../../benchmarks/sequential-learning/adapters/hippo.mjs';
import { storeDirOf } from '../fixtures/sl-adapter/store-dir.js';

describe('sequential-learning adapter contract', () => {
  const baseAdapter = {
    name: 'test',
    init: async () => {},
    store: async () => {},
    recall: async () => [],
    outcome: async () => {},
    cleanup: async () => {},
  };

  it('accepts an adapter without pushGoal/completeGoal (back-compat)', () => {
    expect(createAdapter(baseAdapter)).toBe(baseAdapter);
  });

  it('accepts an adapter with both pushGoal and completeGoal', () => {
    const paired = { ...baseAdapter, pushGoal: async () => 'g_1234567890abcdef', completeGoal: async () => {} };
    expect(createAdapter(paired)).toBe(paired);
  });

  it('rejects adapters that supply only pushGoal without completeGoal', () => {
    expect(() =>
      createAdapter({
        ...baseAdapter,
        pushGoal: async () => 'g_x',
      }),
    ).toThrow(/completeGoal/);
  });

  it('rejects adapters that supply completeGoal without pushGoal', () => {
    expect(() =>
      createAdapter({
        ...baseAdapter,
        completeGoal: async () => {},
      }),
    ).toThrow(/pushGoal/);
  });
});

describe('hippo adapter goal-stack boost fires end-to-end', () => {
  it('writes one row to goal_recall_log after pushGoal+store+recall', async () => {
    await hippoAdapter.init();
    if (!hippoAdapter.pushGoal || !hippoAdapter.completeGoal) {
      throw new Error('the hippo adapter must supply the goal hooks');
    }
    try {
      const goalId = await hippoAdapter.pushGoal('bare_except');
      expect(goalId).toMatch(/^g_[0-9a-f]{16}$/);

      await hippoAdapter.store('Never use bare except: pass. It swallows all errors silently.', [
        'bare_except',
        'error-handling',
        'exception',
        'python',
        'error',
      ]);

      const recalled = await hippoAdapter.recall('handling errors in data pipeline');
      expect(Array.isArray(recalled)).toBe(true);
      expect(recalled.map((r) => r.content)).toEqual(['Never use bare except: pass. It swallows all errors silently.']);

      const storeDir = storeDirOf(hippoAdapter);
      if (!storeDir) throw new Error('init() left no store dir');
      expect(existsSync(storeDir)).toBe(true);

      const localDbPath = join(storeDir, '.hippo', 'hippo.db');
      const globalDbPath = join(storeDir, 'hippo.db');
      const dbToOpen = existsSync(localDbPath) ? localDbPath : globalDbPath;
      expect(existsSync(dbToOpen)).toBe(true);

      // Vitest can't resolve `node:sqlite` via ESM import (vite intercepts it),
      // so use createRequire — the same trick src/db/index.ts uses.
      const nodeRequire = createRequire(import.meta.url);
      // SAFETY: node:sqlite's DatabaseSync shape is fixed by the runtime
      // module; DatabaseSyncLike is db.ts's own typed contract for it (the
      // same trick src/db/index.ts uses to require this module).
      const { DatabaseSync } = nodeRequire('node:sqlite') as {
        DatabaseSync: new (path: string) => DatabaseSyncLike;
      };
      const db = new DatabaseSync(dbToOpen);
      try {
        // SAFETY: query is a fixed `COUNT(*) AS n` aggregate, which always
        // returns exactly one row shaped { n: number }.
        const row = db.prepare('SELECT COUNT(*) AS n FROM goal_recall_log').get() as { n: number };
        expect(row.n).toBe(1);
      } finally {
        db.close();
      }

      await hippoAdapter.completeGoal(goalId, true);
    } finally {
      await hippoAdapter.cleanup();
    }
  });
});
