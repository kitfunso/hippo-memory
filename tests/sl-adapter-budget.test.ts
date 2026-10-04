import { describe, it, expect } from 'vitest';
import hippoAdapter from '../benchmarks/sequential-learning/adapters/hippo.mjs';
import baselineAdapter from '../benchmarks/sequential-learning/adapters/baseline.mjs';
import staticAdapter from '../benchmarks/sequential-learning/adapters/static.mjs';

describe('sequential-learning adapter recall budget', () => {
  it('hippo adapter honors the budget arg with OBSERVABLE result-count delta at extreme budgets (post-review P0-6)', async () => {
    await hippoAdapter.init();
    try {
      // Seed with many memories so an extreme-low budget collapses the result set.
      for (let i = 0; i < 30; i++) {
        await hippoAdapter.store(`lesson ${i}: do not commit broken code, item ${i}`, [
          'lesson',
          `lesson_${i}`,
        ]);
      }
      const wide = await hippoAdapter.recall('do not commit broken code', 2000);
      const tiny = await hippoAdapter.recall('do not commit broken code', 1);
      // Budget=1 must collapse the result set well below budget=2000. We assert
      // an OBSERVABLE delta (not just <=), so the test cannot pass if --budget
      // is silently ignored. If hippo's --budget enforcement is strict, tiny=0;
      // if lenient (returns at least 1 hit), it MUST be strictly fewer than wide.
      expect(wide.length).toBeGreaterThanOrEqual(3); // sanity: 30 memories, query matches
      expect(tiny.length).toBeLessThan(wide.length); // STRICT inequality, not <=
    } finally {
      await hippoAdapter.cleanup();
    }
  }, 60_000);

  it('hippo adapter defaults to 2000 when budget arg is omitted (backward compat)', async () => {
    await hippoAdapter.init();
    try {
      await hippoAdapter.store('compat lesson', ['compat']);
      // Single-arg signature must not throw.
      const results = await hippoAdapter.recall('compat lesson');
      expect(Array.isArray(results)).toBe(true);
    } finally {
      await hippoAdapter.cleanup();
    }
  }, 30_000);

  it('baseline adapter ignores the budget arg cleanly', async () => {
    await baselineAdapter.init();
    try {
      const r1 = await baselineAdapter.recall('anything', 100);
      const r2 = await baselineAdapter.recall('anything');
      // Baseline always returns []; budget arg must not throw.
      expect(r1).toEqual([]);
      expect(r2).toEqual([]);
    } finally {
      await baselineAdapter.cleanup();
    }
  });

  it('static adapter ignores the budget arg cleanly', async () => {
    await staticAdapter.init();
    try {
      const r1 = await staticAdapter.recall('overwrite production', 100);
      const r2 = await staticAdapter.recall('overwrite production');
      // Static returns the full pre-loaded lesson set; budget arg must not throw.
      expect(Array.isArray(r1)).toBe(true);
      expect(Array.isArray(r2)).toBe(true);
    } finally {
      await staticAdapter.cleanup();
    }
  });
});
