import { describe, it, expect } from 'vitest';
import hippoAdapter from '../../benchmarks/sequential-learning/adapters/hippo.mjs';
import baselineAdapter from '../../benchmarks/sequential-learning/adapters/baseline.mjs';
import staticAdapter from '../../benchmarks/sequential-learning/adapters/static.mjs';

describe('sequential-learning adapter recall budget', () => {
  it('hippo adapter honors the budget arg with OBSERVABLE result-count delta at extreme budgets', async () => {
    await hippoAdapter.init();
    try {
      for (let i = 0; i < 6; i++) {
        await hippoAdapter.store(`lesson ${i}: do not commit broken code, item ${i}`, ['lesson', `lesson_${i}`]);
      }
      const wide = await hippoAdapter.recall('do not commit broken code', 2000);
      const tiny = await hippoAdapter.recall('do not commit broken code', 1);
      expect(wide.length).toBeGreaterThanOrEqual(3);
      expect(tiny.length).toBeLessThan(wide.length);
    } finally {
      await hippoAdapter.cleanup();
    }
  });

  it('hippo adapter defaults to 2000 when budget arg is omitted (backward compat)', async () => {
    await hippoAdapter.init();
    try {
      await hippoAdapter.store('compat lesson', ['compat']);
      const results = await hippoAdapter.recall('compat lesson');
      expect(Array.isArray(results)).toBe(true);
    } finally {
      await hippoAdapter.cleanup();
    }
  });

  it('baseline adapter ignores the budget arg cleanly', async () => {
    await baselineAdapter.init();
    try {
      const r1 = await baselineAdapter.recall('anything', 100);
      const r2 = await baselineAdapter.recall('anything');
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
      expect(Array.isArray(r1)).toBe(true);
      expect(Array.isArray(r2)).toBe(true);
    } finally {
      await staticAdapter.cleanup();
    }
  });
});
