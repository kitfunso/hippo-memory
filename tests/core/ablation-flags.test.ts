import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import * as path from 'node:path';
import { calculateStrength, createMemory, applyOutcome, markRetrieved } from '../../src/entry/memory.js';
import { calculateRewardFactor, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { hybridSearch } from '../../src/entry/folder-search.js';
import { outcomeMultiplier } from '../../src/domain/search/boosts.js';
import { evalNow, evalSwitches, type StrengthAblation } from '../../src/infra/eval-switches.js';
import {
  envAblateDecay,
  envAblateOutcome,
  envAblateOutcomeSlow,
  envAblateRecallBoost,
} from '../../src/base/util/env.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const ablation = (): StrengthAblation => ({
  decay: envAblateDecay(),
  recallBoost: envAblateRecallBoost(),
  outcomeSlow: envAblateOutcome() || envAblateOutcomeSlow(),
});
const abl = () => ({ ablation: ablation() });

const ABLATION_ENV_VARS = [
  'HIPPO_ABLATE_DECAY',
  'HIPPO_ABLATE_RECALL_BOOST',
  'HIPPO_ABLATE_OUTCOME',
  'HIPPO_ABLATE_OUTCOME_SLOW',
  'HIPPO_ABLATE_OUTCOME_FAST',
  'HIPPO_ABLATE_RECENCY',
  'HIPPO_EVAL_RECENCY_DAYS',
  'HIPPO_FAKE_NOW',
] as const;

function clearAblationEnv(): void {
  for (const v of ABLATION_ENV_VARS) vi.stubEnv(v, undefined);
}

beforeEach(clearAblationEnv);
afterEach(clearAblationEnv);

function agedMemory(daysAgo: number, content = 'aged memory content'): MemoryEntry {
  const m = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  const then = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  m.created = then;
  m.lastRetrieved = then;
  m.halfLifeDays = 7;
  return m;
}

const NOW = new Date('2026-06-11T12:00:00.000Z');

describe('defaults (no flags set)', () => {
  it('decay, strengthening, and both outcome channels all run', async () => {
    expect(calculateStrength(agedMemory(30), NOW, abl())).toBeLessThan(calculateStrength(agedMemory(0), NOW, abl()));
    const [marked] = markRetrieved([agedMemory(30)], NOW, abl());
    expect(marked.retrievalCount).toBe(1);
    expect(marked.lastRetrieved).toBe(NOW.toISOString());
    expect(marked.halfLifeDays).toBe(9);
    let m = createMemory('outcome-laden', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m, evalSwitches().strength)).toBeGreaterThan(1);
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBeGreaterThan(1);
  });
});

describe('HIPPO_ABLATE_RECENCY / HIPPO_EVAL_RECENCY_DAYS', () => {
  const recencyOf = async (daysAgo: number): Promise<number> => {
    const m = agedMemory(daysAgo, 'recency probe memory');
    const [r] = await hybridSearch('recency probe', [m], { budget: 10000, explain: true, now: NOW });
    return r.breakdown!.recencyMultiplier;
  };
  const setEnv = (k: string, v: string): void => {
    vi.stubEnv(k, v);
  };

  it('default: an older memory gets a recency multiplier below 1', async () => {
    expect(await recencyOf(30)).toBeLessThan(0.9);
  });

  it('ablated: the multiplier is 1 and decay stays live (isolation)', async () => {
    setEnv('HIPPO_ABLATE_RECENCY', '1');
    expect(await recencyOf(30)).toBe(1);
    expect(calculateStrength(agedMemory(30), NOW, abl())).toBeLessThan(calculateStrength(agedMemory(0), NOW, abl()));
  });

  it('a 7-day scale lowers the multiplier; junk values keep 30', async () => {
    const base = await recencyOf(30);
    setEnv('HIPPO_EVAL_RECENCY_DAYS', '7');
    expect(await recencyOf(30)).toBeLessThan(base);
    for (const junk of ['0', '-5', 'abc']) {
      setEnv('HIPPO_EVAL_RECENCY_DAYS', junk);
      expect(await recencyOf(30)).toBe(base);
    }
  });

  it('outcomeMultiplier matches the breakdown outcomeBoost', async () => {
    const m = applyOutcome(createMemory('outcome parity memory', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), true);
    const [r] = await hybridSearch('outcome parity', [m], { budget: 10000, explain: true });
    expect(outcomeMultiplier(m, false)).toBe(r.breakdown!.outcomeBoost);
    expect(outcomeMultiplier(m, false)).toBeGreaterThan(1);
  });
});

describe('HIPPO_ABLATE_DECAY', () => {
  beforeEach(() => {
    vi.stubEnv('HIPPO_ABLATE_DECAY', '1');
  });

  it('neutralizes decay: a 30-day-old memory equals a fresh one', () => {
    expect(calculateStrength(agedMemory(30), NOW, abl())).toBe(calculateStrength(agedMemory(0), NOW, abl()));
  });

  it('isolation: strengthening writes still run', () => {
    const [marked] = markRetrieved([agedMemory(30)], NOW, abl());
    expect(marked.retrievalCount).toBe(1);
    expect(marked.halfLifeDays).toBe(9);
  });

  it('isolation: slow outcome channel still runs', () => {
    let m = createMemory('outcome-laden', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m = applyOutcome(m, false);
    expect(calculateRewardFactor(m, evalSwitches().strength)).toBeLessThan(1);
  });

  it('documents the clamp interaction: read-side retrieval boost saturates at 1', () => {
    const m = agedMemory(0);
    m.retrievalCount = 16;
    expect(calculateStrength(m, NOW, abl())).toBe(1.0);
    expect(calculateStrength(agedMemory(0), NOW, abl())).toBe(1.0);
  });

  it('documents the co-ablation: outcome-slow is inert when decay is off', async () => {
    let bad = agedMemory(10, 'outcome laden memory');
    bad = applyOutcome(applyOutcome(bad, false), false);
    const plain = agedMemory(10, 'outcome laden memory');
    expect(calculateStrength(bad, NOW, abl())).toBe(calculateStrength(plain, NOW, abl()));
    const results = await hybridSearch('outcome laden memory', [bad], {
      budget: 10000,
      explain: true,
    });
    expect(results[0].breakdown?.outcomeBoost).toBeLessThan(1);
  });
});

describe('HIPPO_ABLATE_RECALL_BOOST', () => {
  beforeEach(() => {
    vi.stubEnv('HIPPO_ABLATE_RECALL_BOOST', '1');
  });

  it('neutralizes ALL THREE strengthening sub-effects; entries returned unmutated', () => {
    const before = agedMemory(30);
    before.confidence = 'stale';
    const result = markRetrieved([before], NOW, abl());
    expect(result.length).toBe(1);
    expect(result[0]).toBe(before);
    expect(result[0].retrievalCount).toBe(0);
    expect(result[0].lastRetrieved).not.toBe(NOW.toISOString());
    expect(result[0].halfLifeDays).toBe(7);
    expect(result[0].confidence).toBe('stale');
  });

  it('physics mass recomputed under ablated rules ignores ALL recall history', async () => {
    const { computeMass } = await import('../../src/base/rank/physics.js');
    const created = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const hot = agedMemory(10);
    hot.created = created;
    hot.retrievalCount = 16;
    hot.lastRetrieved = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const cold = agedMemory(10);
    cold.created = created;
    expect(computeMass(calculateStrength(hot, NOW, abl()), hot.retrievalCount, evalSwitches().strength)).toBe(
      computeMass(calculateStrength(cold, NOW, abl()), cold.retrievalCount, evalSwitches().strength),
    );
  });

  it('isolation: decay still runs', () => {
    expect(calculateStrength(agedMemory(30), NOW, abl())).toBeLessThan(calculateStrength(agedMemory(0), NOW, abl()));
  });

  it('neutralizes the READ side too: prior retrieval_count > 0 gives no boost', () => {
    const withHistory = agedMemory(10);
    withHistory.retrievalCount = 16;
    const without = agedMemory(10);
    expect(calculateStrength(withHistory, NOW, abl())).toBe(calculateStrength(without, NOW, abl()));
  });

  it('neutralizes physics particle mass too: retrieval history cannot leak via gravity', async () => {
    const { computeMass } = await import('../../src/base/rank/physics.js');
    expect(computeMass(0.8, 16, evalSwitches().strength)).toBe(computeMass(0.8, 0, evalSwitches().strength));
    clearAblationEnv();
    expect(computeMass(0.8, 16, evalSwitches().strength)).toBeGreaterThan(computeMass(0.8, 0, evalSwitches().strength));
  });

  it('anchors decay at created: prior clock resets cannot leak in', () => {
    const created = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const reset = createMemory('clock reset by a prior run', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    reset.created = created;
    reset.lastRetrieved = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    reset.halfLifeDays = 7;
    const untouched = createMemory('never retrieved', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    untouched.created = created;
    untouched.lastRetrieved = created;
    untouched.halfLifeDays = 7;
    expect(calculateStrength(reset, NOW, abl())).toBe(calculateStrength(untouched, NOW, abl()));
    clearAblationEnv();
    expect(calculateStrength(reset, NOW, abl())).toBeGreaterThan(calculateStrength(untouched, NOW, abl()));
  });

  it('isolation: both outcome channels still run', async () => {
    let m = createMemory('outcome-laden', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m, evalSwitches().strength)).toBeGreaterThan(1);
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBeGreaterThan(1);
  });
});

describe('HIPPO_ABLATE_OUTCOME', () => {
  beforeEach(() => {
    vi.stubEnv('HIPPO_ABLATE_OUTCOME', '1');
  });

  it('neutralizes the slow channel (rewardFactor = 1 despite outcomes)', () => {
    let m = createMemory('outcome-laden', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m = applyOutcome(m, true);
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m, evalSwitches().strength)).toBe(1.0);
  });

  it('neutralizes the fast channel (outcomeBoost = 1 despite outcomes)', async () => {
    let m = createMemory('outcome-laden', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m = applyOutcome(m, true);
    m = applyOutcome(m, true);
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBe(1);
  });

  it('isolation: decay and strengthening still run', () => {
    expect(calculateStrength(agedMemory(30), NOW, abl())).toBeLessThan(calculateStrength(agedMemory(0), NOW, abl()));
    const [marked] = markRetrieved([agedMemory(30)], NOW, abl());
    expect(marked.retrievalCount).toBe(1);
  });

  it('silences replay reward bias too: outcome counts no longer skew replay priority', async () => {
    const { replayPriority } = await import('../../src/domain/consolidate/replay.js');
    let rewarded = agedMemory(5, 'replay candidate');
    rewarded = applyOutcome(applyOutcome(rewarded, true), true);
    const plain = agedMemory(5, 'replay candidate');
    rewarded.strength = calculateStrength(rewarded, NOW, abl());
    plain.strength = calculateStrength(plain, NOW, abl());
    expect(replayPriority(rewarded, NOW, evalSwitches().strength.rewardSlope === 0)).toBe(
      replayPriority(plain, NOW, evalSwitches().strength.rewardSlope === 0),
    );
    clearAblationEnv();
    rewarded.strength = calculateStrength(rewarded, NOW, abl());
    plain.strength = calculateStrength(plain, NOW, abl());
    expect(replayPriority(rewarded, NOW, evalSwitches().strength.rewardSlope === 0)).toBeGreaterThan(
      replayPriority(plain, NOW, evalSwitches().strength.rewardSlope === 0),
    );
  });
});

describe('HIPPO_ABLATE_OUTCOME_SLOW (decomposition arm)', () => {
  beforeEach(() => {
    vi.stubEnv('HIPPO_ABLATE_OUTCOME_SLOW', '1');
  });

  it('slow off, fast still live', async () => {
    let m = createMemory('outcome-laden', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m, evalSwitches().strength)).toBe(1.0);
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBeGreaterThan(1);
  });
});

describe('HIPPO_ABLATE_OUTCOME_FAST (decomposition arm)', () => {
  beforeEach(() => {
    vi.stubEnv('HIPPO_ABLATE_OUTCOME_FAST', '1');
  });

  it('fast off, slow still live', async () => {
    let m = createMemory('outcome-laden', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m, evalSwitches().strength)).toBeGreaterThan(1);
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBe(1);
  });
});

describe('HIPPO_FAKE_NOW', () => {
  it('injects the fake clock as the default now', () => {
    vi.stubEnv('HIPPO_FAKE_NOW', '2030-01-01T00:00:00.000Z');
    expect(evalNow().toISOString()).toBe('2030-01-01T00:00:00.000Z');
    const realFresh = createMemory('fresh in 2026', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    realFresh.created = '2026-06-11T00:00:00.000Z';
    realFresh.lastRetrieved = '2026-06-11T00:00:00.000Z';
    realFresh.halfLifeDays = 7;
    expect(calculateStrength(realFresh, undefined, abl())).toBeLessThan(0.01);
    expect(createMemory('stamped in 2030', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }).created).toBe(
      '2030-01-01T00:00:00.000Z',
    );
    const [marked] = markRetrieved(
      [createMemory('stamp me', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS })],
      undefined,
      abl(),
    );
    expect(marked.lastRetrieved).toBe('2030-01-01T00:00:00.000Z');
  });

  it('flows through search scoring, not just retrieval stamping', async () => {
    vi.stubEnv('HIPPO_FAKE_NOW', '2030-01-01T00:00:00.000Z');
    const m = createMemory('search scoring uses the fake clock', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m.created = '2026-06-11T00:00:00.000Z';
    m.lastRetrieved = '2026-06-11T00:00:00.000Z';
    m.halfLifeDays = 7;
    const results = await hybridSearch('search scoring fake clock', [m], {
      budget: 10000,
      explain: true,
    });
    expect(results[0].breakdown?.strengthMultiplier).toBeLessThan(0.51);
  });

  it('invalid value falls back to the real clock', () => {
    vi.stubEnv('HIPPO_FAKE_NOW', 'not-a-date');
    const before = Date.now();
    const now = evalNow().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('rejects non-canonical formats Date.parse would accept', () => {
    for (const junk of [
      '1',
      '06/11/2026',
      '2026-06-11',
      '2026-06-11T12:00:00',
      '2026-06-11T12:00:00+01:00',
      '2026-06-11T12:00:00Z', // millis required (exact toISOString form)
      '2026-02-31T00:00:00.000Z', // rollover (codex round-3 P2)
      '2026-13-01T00:00:00.000Z', // rollover month
    ]) {
      vi.stubEnv('HIPPO_FAKE_NOW', junk);
      const before = Date.now();
      const now = evalNow().getTime();
      expect(now, `format '${junk}' must fall back to real clock`).toBeGreaterThanOrEqual(before);
      expect(now, `format '${junk}' must fall back to real clock`).toBeLessThanOrEqual(Date.now());
    }
  });

  it('flows through the searchBothHybrid wrapper default too', async () => {
    vi.stubEnv('HIPPO_FAKE_NOW', '2030-01-01T00:00:00.000Z');
    const { searchBothHybrid } = await import('../../src/domain/sharing/search-both.js');
    const m = createMemory('wrapper clock consistency check', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    m.created = '2026-06-11T00:00:00.000Z';
    m.lastRetrieved = '2026-06-11T00:00:00.000Z';
    m.halfLifeDays = 7;
    const tmp = makeRoot('abl');
    const { writeEntry } = await import('../_helpers/root-forms.js');
    writeEntry(tmp, m);
    const results = await searchBothHybrid(
      'wrapper clock consistency check',
      ...sharingStores(tmp, path.join(tmp, 'no-global')),
      { now: evalNow(), tenantId: ALL_TENANTS, embedderFor: resolveEmbeddingProvider, budget: 10000, explain: true },
    );
    expect(results).toHaveLength(1);
    expect(results[0].breakdown?.strengthMultiplier).toBeLessThan(0.51);
  });

  it('explicit now parameter always wins over the fake clock', () => {
    vi.stubEnv('HIPPO_FAKE_NOW', '2030-01-01T00:00:00.000Z');
    const m = agedMemory(0);
    expect(calculateStrength(m, NOW, abl())).toBe(1.0);
  });
});

describe('core scoring does not read the environment', () => {
  it('calculateStrength ignores HIPPO_ABLATE_DECAY unless the options carry it', () => {
    vi.stubEnv('HIPPO_ABLATE_DECAY', '1');
    expect(calculateStrength(agedMemory(30), NOW)).toBeLessThan(calculateStrength(agedMemory(0), NOW));
    expect(calculateStrength(agedMemory(30), NOW, abl())).toBe(calculateStrength(agedMemory(0), NOW, abl()));
  });
});
