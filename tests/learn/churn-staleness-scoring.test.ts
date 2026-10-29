/** FE2 staleness-from-code-churn: outcome-clearing, rank multiplier and config. */
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createMemory } from '../../src/entry/memory.js';
import { CHURN_STALE_TAG } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { rankBm25 } from '../../src/domain/search/bm25-search.js';
import { hybridSearch } from '../../src/entry/folder-search.js';
import { churnStaleFactor } from '../../src/domain/search/boosts.js';
import { loadConfig } from '../../src/host/config-file.js';
import * as api from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { evalNow } from '../../src/infra/eval-switches.js';

// ---------------------------------------------------------------------------
// api.outcome(): a good outcome clears the churn-stale tag
// ---------------------------------------------------------------------------

describe('api.outcome clears churn-stale on a good outcome', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = makeRoot('churn-outcome');
  });

  afterEach(() => {
    removeDir(hippoRoot);
  });

  it('drops the churn-stale tag on good=true', async () => {
    const mem = createMemory('some tagged content', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: [CHURN_STALE_TAG],
    });
    writeEntry(hippoRoot, mem);

    const ctx: FullContext = apiCtx(hippoRoot, 'default', api.adminActor('test'));
    await api.outcome(ctx, [mem.id], true);

    expect(readEntry(hippoRoot, mem.id)!.tags).not.toContain(CHURN_STALE_TAG);
  });

  it('keeps the churn-stale tag on good=false', async () => {
    const mem = createMemory('some tagged content', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: [CHURN_STALE_TAG],
    });
    writeEntry(hippoRoot, mem);

    const ctx: FullContext = apiCtx(hippoRoot, 'default', api.adminActor('test'));
    await api.outcome(ctx, [mem.id], false);

    expect(readEntry(hippoRoot, mem.id)!.tags).toContain(CHURN_STALE_TAG);
  });

  it('a good outcome on an untagged memory is a no-op for tags', async () => {
    const mem = createMemory('plain content', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: ['other'] });
    writeEntry(hippoRoot, mem);

    const ctx: FullContext = apiCtx(hippoRoot, 'default', api.adminActor('test'));
    await api.outcome(ctx, [mem.id], true);

    expect(readEntry(hippoRoot, mem.id)!.tags).toEqual(['other']);
  });
});

// ---------------------------------------------------------------------------
// search.ts: CHURN_STALE_RANK_MULTIPLIER applied in both scoring paths
// ---------------------------------------------------------------------------

describe('CHURN_STALE_RANK_MULTIPLIER in search scoring', () => {
  const STALE_FACTOR = churnStaleFactor(
    createMemory('any', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, tags: [CHURN_STALE_TAG] }),
  );
  it('halves the sync search() score for a churn-stale entry vs an otherwise-identical one', () => {
    const plain = createMemory('widget factory configuration details here', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['sometag'],
    });
    const stale = createMemory('widget factory configuration details here', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['sometag', CHURN_STALE_TAG],
    });

    const results = rankBm25('widget factory configuration', [plain, stale], { now: evalNow() });
    const plainResult = results.find((r) => r.entry.id === plain.id)!;
    const staleResult = results.find((r) => r.entry.id === stale.id)!;
    expect(staleResult.score).toBeLessThan(plainResult.score * 0.6);
  });

  it('applies CHURN_STALE_RANK_MULTIPLIER in the hybrid explain breakdown', async () => {
    const stale = createMemory('gadget assembly line documentation notes', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: [CHURN_STALE_TAG],
    });
    const [result] = await hybridSearch('gadget assembly line', [stale], { explain: true });
    expect(result.breakdown!.churnStaleMultiplier).toBe(STALE_FACTOR);
  });

  it('ranks a churn-stale entry below an identical untagged one in hybridSearch', async () => {
    const plain = createMemory('sprocket calibration procedure notes', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: [],
    });
    const stale = createMemory('sprocket calibration procedure notes', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: [CHURN_STALE_TAG],
    });
    const results = await hybridSearch('sprocket calibration', [stale, plain]);
    expect(results.map((r) => r.entry.id)).toEqual([plain.id, stale.id]);
  });

  it('penalises a churn-stale child injected by DAG drill-down (sync and hybrid)', async () => {
    const parent = createMemory('quasar ledger overview', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: ['dag-summary'],
    });
    const child = createMemory('unrelated detail text', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: [CHURN_STALE_TAG],
    });
    child.dagParentId = parent.id;
    for (const results of [
      rankBm25('quasar ledger', [parent, child], { now: evalNow() }),
      await hybridSearch('quasar ledger', [parent, child]),
    ]) {
      const p = results.find((r) => r.entry.id === parent.id)!;
      const c = results.find((r) => r.entry.id === child.id)!;
      expect(c.score).toBeCloseTo(p.score * 0.9 * STALE_FACTOR, 6);
    }
  });

  it('sinks a churn-stale row in the default api.recall path (no search scorer)', async () => {
    const hippoRoot = makeRoot('churn-recall');
    try {
      const stale = createMemory('zephyr zephyr zephyr gearbox', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        tags: [CHURN_STALE_TAG],
      });
      const b = createMemory('zephyr gearbox notes with a few more words', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        tags: [],
      });
      const c = createMemory('zephyr gearbox notes with many many more padding words here', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        tags: [],
      });
      for (const m of [stale, b, c]) writeEntry(hippoRoot, m);
      const ctx: FullContext = apiCtx(hippoRoot, 'default', api.adminActor('test'));
      const ids = (await api.retrieve(ctx, { query: 'zephyr' })).results.map((r) => r.id);
      expect(ids).toHaveLength(3);
      expect(ids[0]).not.toBe(stale.id);
    } finally {
      removeDir(hippoRoot);
    }
  });

  it('records churnStaleMultiplier as 1.0 for a non-tagged entry', async () => {
    const plain = createMemory('gadget assembly line documentation notes', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      tags: [],
    });
    const [result] = await hybridSearch('gadget assembly line', [plain], { explain: true });
    expect(result.breakdown!.churnStaleMultiplier).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// config.ts: churnStaleness validation
// ---------------------------------------------------------------------------

describe('config.churnStaleness', () => {
  let hippoRoot: string;

  beforeEach(() => {
    hippoRoot = makeRoot('churn-config');
  });

  afterEach(() => {
    removeDir(hippoRoot);
  });

  it('defaults to disabled', () => {
    expect(loadConfig(hippoRoot).churnStaleness.enabled).toBe(false);
  });

  it('honors an explicit true', () => {
    fs.writeFileSync(path.join(hippoRoot, 'config.json'), JSON.stringify({ churnStaleness: { enabled: true } }));
    expect(loadConfig(hippoRoot).churnStaleness.enabled).toBe(true);
  });

  it('falls back to false and warns on a non-object churnStaleness', () => {
    fs.writeFileSync(path.join(hippoRoot, 'config.json'), JSON.stringify({ churnStaleness: 'yes' }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadConfig(hippoRoot).churnStaleness.enabled).toBe(false);
      expect(stderr.mock.calls.some(([e]) => String(e).includes('"churnStaleness"'))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it('falls back to false and warns on a non-boolean enabled', () => {
    fs.writeFileSync(path.join(hippoRoot, 'config.json'), JSON.stringify({ churnStaleness: { enabled: 'yes' } }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadConfig(hippoRoot).churnStaleness.enabled).toBe(false);
      expect(stderr.mock.calls.some(([e]) => String(e).includes('"churnStaleness.enabled"'))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});
