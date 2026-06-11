/**
 * EVAL-ONLY lifecycle ablation flags (src/ablation.ts).
 *
 * Pre-registered design rev #10 requirement: each flag must neutralize ONLY
 * its intended mechanism. Every block therefore asserts BOTH the ablation
 * (target mechanism off) AND the isolation (the other mechanisms intact).
 *
 * Env isolation pattern (canonical: tests/emotional-multipliers-j5.test.ts):
 * beforeEach AND afterEach clear all ablation env vars + reset the module
 * cache, so no test leaks flags into the next.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  calculateStrength,
  calculateRewardFactor,
  createMemory,
  applyOutcome,
  type MemoryEntry,
} from '../src/memory.js';
import { hybridSearch, markRetrieved } from '../src/search.js';
import { evalNow, _resetAblationCacheForTests } from '../src/ablation.js';

const ABLATION_ENV_VARS = [
  'HIPPO_ABLATE_DECAY',
  'HIPPO_ABLATE_RECALL_BOOST',
  'HIPPO_ABLATE_OUTCOME',
  'HIPPO_ABLATE_OUTCOME_SLOW',
  'HIPPO_ABLATE_OUTCOME_FAST',
  'HIPPO_FAKE_NOW',
] as const;

function clearAblationEnv(): void {
  for (const v of ABLATION_ENV_VARS) delete process.env[v];
  _resetAblationCacheForTests();
}

beforeEach(clearAblationEnv);
afterEach(clearAblationEnv);

/** A memory last retrieved `daysAgo` days before `NOW`, with a short half-life. */
function agedMemory(daysAgo: number, content = 'aged memory content'): MemoryEntry {
  const m = createMemory(content);
  m.last_retrieved = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  m.half_life_days = 7;
  return m;
}

const NOW = new Date('2026-06-11T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Defaults: all flags unset -> behavior identical to pre-ablation hippo
// ---------------------------------------------------------------------------

describe('defaults (no flags set)', () => {
  it('decay, strengthening, and both outcome channels all run', async () => {
    // Decay live: old memory weaker than fresh.
    expect(calculateStrength(agedMemory(30), NOW)).toBeLessThan(
      calculateStrength(agedMemory(0), NOW),
    );
    // Strengthening live: markRetrieved mutates.
    const [marked] = markRetrieved([agedMemory(30)], NOW);
    expect(marked.retrieval_count).toBe(1);
    expect(marked.last_retrieved).toBe(NOW.toISOString());
    expect(marked.half_life_days).toBe(9); // 7 + 2
    // Slow outcome channel live.
    let m = createMemory('outcome-laden');
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m)).toBeGreaterThan(1);
    // Fast outcome channel live.
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// HIPPO_ABLATE_DECAY
// ---------------------------------------------------------------------------

describe('HIPPO_ABLATE_DECAY', () => {
  beforeEach(() => {
    process.env.HIPPO_ABLATE_DECAY = '1';
    _resetAblationCacheForTests();
  });

  it('neutralizes decay: a 30-day-old memory equals a fresh one', () => {
    expect(calculateStrength(agedMemory(30), NOW)).toBe(calculateStrength(agedMemory(0), NOW));
  });

  it('isolation: strengthening writes still run', () => {
    const [marked] = markRetrieved([agedMemory(30)], NOW);
    expect(marked.retrieval_count).toBe(1);
    expect(marked.half_life_days).toBe(9);
  });

  it('isolation: slow outcome channel still runs', () => {
    let m = createMemory('outcome-laden');
    m = applyOutcome(m, false);
    expect(calculateRewardFactor(m)).toBeLessThan(1);
  });

  it('documents the clamp interaction: read-side retrieval boost saturates at 1', () => {
    // With decay := 1, raw = retrievalBoost * emotionalMult >= 1, clamped to 1.
    // The strengthening READ-side therefore flattens when decay is off (the
    // boost can only offset decay, never exceed baseline). See ablation.ts.
    const m = agedMemory(0);
    m.retrieval_count = 16;
    expect(calculateStrength(m, NOW)).toBe(1.0);
    expect(calculateStrength(agedMemory(0), NOW)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// HIPPO_ABLATE_RECALL_BOOST
// ---------------------------------------------------------------------------

describe('HIPPO_ABLATE_RECALL_BOOST', () => {
  beforeEach(() => {
    process.env.HIPPO_ABLATE_RECALL_BOOST = '1';
    _resetAblationCacheForTests();
  });

  it('neutralizes ALL THREE strengthening sub-effects (no-op markRetrieved)', () => {
    const before = agedMemory(30);
    before.confidence = 'stale';
    const result = markRetrieved([before], NOW);
    expect(result[0]).toBe(before); // identical object, untouched
    expect(result[0].retrieval_count).toBe(0); // no count
    expect(result[0].last_retrieved).not.toBe(NOW.toISOString()); // no clock reset
    expect(result[0].half_life_days).toBe(7); // no +2
    expect(result[0].confidence).toBe('stale'); // no stale->observed promotion
  });

  it('isolation: decay still runs', () => {
    expect(calculateStrength(agedMemory(30), NOW)).toBeLessThan(
      calculateStrength(agedMemory(0), NOW),
    );
  });

  it('neutralizes the READ side too: prior retrieval_count > 0 gives no boost (codex P2)', () => {
    // A store written BEFORE the flag was set can carry counts; the ablated
    // arm must not let that history leak strengthening into rankings.
    const withHistory = agedMemory(10);
    withHistory.retrieval_count = 16;
    const without = agedMemory(10);
    expect(calculateStrength(withHistory, NOW)).toBe(calculateStrength(without, NOW));
  });

  it('isolation: both outcome channels still run', async () => {
    let m = createMemory('outcome-laden');
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m)).toBeGreaterThan(1);
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// HIPPO_ABLATE_OUTCOME (both channels) / _SLOW / _FAST (decomposition)
// ---------------------------------------------------------------------------

describe('HIPPO_ABLATE_OUTCOME', () => {
  beforeEach(() => {
    process.env.HIPPO_ABLATE_OUTCOME = '1';
    _resetAblationCacheForTests();
  });

  it('neutralizes the slow channel (rewardFactor = 1 despite outcomes)', () => {
    let m = createMemory('outcome-laden');
    m = applyOutcome(m, true);
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m)).toBe(1.0);
  });

  it('neutralizes the fast channel (outcomeBoost = 1 despite outcomes)', async () => {
    let m = createMemory('outcome-laden');
    m = applyOutcome(m, true);
    m = applyOutcome(m, true);
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBe(1);
  });

  it('isolation: decay and strengthening still run', () => {
    expect(calculateStrength(agedMemory(30), NOW)).toBeLessThan(
      calculateStrength(agedMemory(0), NOW),
    );
    const [marked] = markRetrieved([agedMemory(30)], NOW);
    expect(marked.retrieval_count).toBe(1);
  });
});

describe('HIPPO_ABLATE_OUTCOME_SLOW (decomposition arm)', () => {
  beforeEach(() => {
    process.env.HIPPO_ABLATE_OUTCOME_SLOW = '1';
    _resetAblationCacheForTests();
  });

  it('slow off, fast still live', async () => {
    let m = createMemory('outcome-laden');
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m)).toBe(1.0); // slow off
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBeGreaterThan(1); // fast on
  });
});

describe('HIPPO_ABLATE_OUTCOME_FAST (decomposition arm)', () => {
  beforeEach(() => {
    process.env.HIPPO_ABLATE_OUTCOME_FAST = '1';
    _resetAblationCacheForTests();
  });

  it('fast off, slow still live', async () => {
    let m = createMemory('outcome-laden');
    m = applyOutcome(m, true);
    expect(calculateRewardFactor(m)).toBeGreaterThan(1); // slow on
    const results = await hybridSearch('outcome-laden', [m], { budget: 10000, explain: true });
    expect(results[0].breakdown?.outcomeBoost).toBe(1); // fast off
  });
});

// ---------------------------------------------------------------------------
// HIPPO_FAKE_NOW (simulated time)
// ---------------------------------------------------------------------------

describe('HIPPO_FAKE_NOW', () => {
  it('injects the fake clock as the default now', () => {
    process.env.HIPPO_FAKE_NOW = '2030-01-01T00:00:00.000Z';
    _resetAblationCacheForTests();
    expect(evalNow().toISOString()).toBe('2030-01-01T00:00:00.000Z');
    // Default-now path of calculateStrength uses the fake clock: a memory
    // "fresh" relative to real time decays hard against the 2030 clock.
    const realFresh = createMemory('fresh in 2026');
    realFresh.half_life_days = 7;
    expect(calculateStrength(realFresh)).toBeLessThan(0.01);
    // markRetrieved default stamp = fake now.
    const [marked] = markRetrieved([createMemory('stamp me')]);
    expect(marked.last_retrieved).toBe('2030-01-01T00:00:00.000Z');
  });

  it('flows through search scoring, not just retrieval stamping (codex P2)', async () => {
    // Without the search-default wiring, scoring would use the REAL clock while
    // markRetrieved stamps the fake one - inconsistent simulated time.
    process.env.HIPPO_FAKE_NOW = '2030-01-01T00:00:00.000Z';
    _resetAblationCacheForTests();
    const m = createMemory('search scoring uses the fake clock');
    m.half_life_days = 7; // fresh in real time, ancient against the 2030 clock
    const results = await hybridSearch('search scoring fake clock', [m], {
      budget: 10000,
      explain: true,
    });
    // strengthMultiplier = 0.5 + 0.5 * strength; strength ~ 0 under the 2030 clock.
    expect(results[0].breakdown?.strengthMultiplier).toBeLessThan(0.51);
  });

  it('invalid value falls back to the real clock', () => {
    process.env.HIPPO_FAKE_NOW = 'not-a-date';
    _resetAblationCacheForTests();
    const drift = Math.abs(evalNow().getTime() - Date.now());
    expect(drift).toBeLessThan(5000);
  });

  it('explicit now parameter always wins over the fake clock', () => {
    process.env.HIPPO_FAKE_NOW = '2030-01-01T00:00:00.000Z';
    _resetAblationCacheForTests();
    const m = agedMemory(0);
    expect(calculateStrength(m, NOW)).toBe(1.0); // explicit NOW, not 2030
  });
});
