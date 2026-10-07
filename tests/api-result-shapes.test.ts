/**
 * Behaviour check of the result shapes getContext, sleep and outcomeForLastRecall
 * return from a real store (tests are not type-checked, so type assertions never fail).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { loadIndex, saveIndex } from '../src/store/index-and-stats.js';
import { remember, getContext, sleep, outcomeForLastRecall, type HippoDbContext } from '../src/api.js';

describe('api result shapes on a real store', () => {
  let home: string;
  let globalHome: string;
  let savedHippoHome: string | undefined;
  let ctx: HippoDbContext;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-api-shapes-'));
    globalHome = mkdtempSync(join(tmpdir(), 'hippo-api-shapes-global-'));
    savedHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    initStore(home);
    ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
  });

  afterEach(() => {
    if (savedHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = savedHippoHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('getContext returns entries carrying a finite score and a positive token count', async () => {
    remember(ctx, { content: 'shape-context-alpha', kind: 'distilled' });
    remember(ctx, { content: 'shape-context-beta', kind: 'distilled' });

    const result = await getContext(ctx, { budget: 1500 });

    expect(result.entries.map((e) => e.entry.content).sort()).toEqual(['shape-context-alpha', 'shape-context-beta']);
    for (const e of result.entries) {
      expect(Number.isFinite(e.score)).toBe(true);
      expect(e.tokens).toBeGreaterThan(0);
    }
    expect(result.tokens).toBe(result.entries.reduce((sum, e) => sum + e.tokens, 0));
  });

  it('getContext limit caps the number of entries returned', async () => {
    for (let i = 0; i < 4; i++) remember(ctx, { content: `shape-limit-${i}`, kind: 'distilled' });

    const result = await getContext(ctx, { budget: 1500, limit: 2 });

    expect(result.entries).toHaveLength(2);
  });

  it('sleep dryRun reports counters without removing memories', async () => {
    remember(ctx, { content: 'shape-sleep-one', kind: 'distilled' });

    const result = await sleep(ctx, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.removed).toBe(0);
    const after = await getContext(ctx, { budget: 1500 });
    expect(after.entries).toHaveLength(1);
  });

  it('sleep on a populated store returns numeric consolidation counters', async () => {
    remember(ctx, { content: 'shape-sleep-two', kind: 'distilled' });

    const result = await sleep(ctx, { dryRun: false, noShare: true });

    expect(result.dryRun).toBe(false);
    for (const n of [result.active, result.removed, result.mergedEpisodic, result.newSemantic]) {
      expect(Number.isInteger(n)).toBe(true);
    }
    expect(result.active).toBe(1);
  });

  it('outcomeForLastRecall returns the ids it applied to', () => {
    const id = remember(ctx, { content: 'shape-outcome', kind: 'distilled' }).id;
    const idx = loadIndex(home);
    idx.last_retrieval_ids = [id];
    saveIndex(home, idx);

    expect(outcomeForLastRecall(ctx, true)).toEqual({ applied: 1, ids: [id] });
  });
});
