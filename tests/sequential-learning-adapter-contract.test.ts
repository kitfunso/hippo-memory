/**
 * v1.7.5 Task 1 — sequential-learning adapter contract gains optional
 * pushGoal/completeGoal hooks for B3 dlPFC goal-stack exercising.
 * Optional so non-goal-aware adapters keep working unchanged.
 *
 * Plus one integration test that proves the goal-stack boost actually
 * fires through the public benchmark adapter (the eval can't run without
 * this) — pushes a goal `bare_except`, stores a memory tagged
 * `bare_except`, recalls, then asserts `goal_recall_log` has rows.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
// @ts-expect-error - .mjs adapter module without .d.ts
import { createAdapter } from '../benchmarks/sequential-learning/adapters/interface.mjs';
// @ts-expect-error - .mjs adapter module without .d.ts
import hippoAdapter from '../benchmarks/sequential-learning/adapters/hippo.mjs';

describe('sequential-learning adapter contract (v1.7.5)', () => {
  const baseAdapter = {
    name: 'test',
    init: async () => {},
    store: async () => {},
    recall: async () => [],
    outcome: async () => {},
    cleanup: async () => {},
  };

  it('accepts an adapter without pushGoal/completeGoal (back-compat)', () => {
    expect(() => createAdapter(baseAdapter)).not.toThrow();
  });

  it('accepts an adapter with both pushGoal and completeGoal', () => {
    expect(() =>
      createAdapter({
        ...baseAdapter,
        pushGoal: async () => 'g_1234567890abcdef',
        completeGoal: async () => {},
      }),
    ).not.toThrow();
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

// ---------------------------------------------------------------------------
// Integration: goal-stack boost fires end-to-end through the hippo adapter.
// This is the load-bearing assertion for the v1.7.5 eval. If `goal_recall_log`
// stays empty, the boost mechanism cannot fire and the eval cannot run.
// ---------------------------------------------------------------------------

describe('hippo adapter goal-stack boost fires end-to-end', () => {
  it('writes at least one row to goal_recall_log after pushGoal+store+recall', async () => {
    // We use the public adapter so any wiring bug surfaces. The adapter
    // creates its own temp HIPPO_HOME and sets HIPPO_SESSION_ID for us.
    await hippoAdapter.init();
    try {
      // Push a goal whose name MATCHES a tag we will store.
      const goalId = await hippoAdapter.pushGoal('bare_except');
      expect(goalId).toMatch(/^g_[0-9a-f]{16}$/);

      // Store a memory tagged with the goal name (this is the boost-firing
      // tag-fix that simulate() applies). recall() must see the memory under
      // the active goal so goal_recall_log gets a row.
      await hippoAdapter.store(
        'Never use bare except: pass. It swallows all errors silently.',
        ['bare_except', 'error-handling', 'exception', 'python', 'error'],
      );

      const recalled = await hippoAdapter.recall('handling errors in data pipeline');
      expect(Array.isArray(recalled)).toBe(true);
      expect(recalled.length).toBeGreaterThan(0);

      // Query the temp store directly. The adapter exposes _storeDir.
      const storeDir = (hippoAdapter as { _storeDir: string })._storeDir;
      expect(storeDir && existsSync(storeDir)).toBeTruthy();

      // hippo doesn't ship a `goal recall-log` subcommand, so we open the db
      // directly via node's native `node:sqlite` (same module hippo uses).
      // The benchmark adapter runs `hippo init --no-schedule` from cwd =
      // storeDir, which creates the local store at <storeDir>/.hippo/hippo.db.
      const localDbPath = join(storeDir, '.hippo', 'hippo.db');
      const globalDbPath = join(storeDir, 'hippo.db');
      const dbToOpen = existsSync(localDbPath) ? localDbPath : globalDbPath;
      expect(existsSync(dbToOpen)).toBeTruthy();

      // Vitest can't resolve `node:sqlite` via ESM import (vite intercepts it),
      // so use createRequire — the same trick src/db.ts uses.
      const nodeRequire = createRequire(import.meta.url);
      const { DatabaseSync } = nodeRequire('node:sqlite') as {
        DatabaseSync: new (path: string) => {
          prepare(sql: string): { get(...args: unknown[]): unknown };
          close(): void;
        };
      };
      const db = new DatabaseSync(dbToOpen);
      try {
        const row = db
          .prepare('SELECT COUNT(*) AS n FROM goal_recall_log')
          .get() as { n: number };
        expect(row.n).toBeGreaterThan(0);
      } finally {
        db.close();
      }

      await hippoAdapter.completeGoal(goalId, true);
    } finally {
      await hippoAdapter.cleanup();
    }
  }, 60_000);
});
