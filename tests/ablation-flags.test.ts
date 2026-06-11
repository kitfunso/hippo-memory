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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

/** A memory created AND last retrieved `daysAgo` days before `NOW` (i.e. aged
 *  and never strengthened since), with a short half-life. Both timestamps are
 *  backdated so the helper means the same thing under both decay anchors
 *  (last_retrieved normally, created under HIPPO_ABLATE_RECALL_BOOST). */
function agedMemory(daysAgo: number, content = 'aged memory content'): MemoryEntry {
  const m = createMemory(content);
  const then = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  m.created = then;
  m.last_retrieved = then;
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

  it('documents the co-ablation: outcome-slow is inert when decay is off (codex P2)', async () => {
    // rewardFactor acts ONLY by scaling the effective half-life inside the
    // decay exponent; with decay := 1 there is nothing to modulate. The
    // decay-off arm is therefore "decay + outcome-slow off" BY CONSTRUCTION
    // (prereg amendment A1). The fast channel is unaffected.
    let bad = agedMemory(10, 'outcome laden memory');
    bad = applyOutcome(applyOutcome(bad, false), false);
    const plain = agedMemory(10, 'outcome laden memory');
    expect(calculateStrength(bad, NOW)).toBe(calculateStrength(plain, NOW)); // slow inert
    const results = await hybridSearch('outcome laden memory', [bad], {
      budget: 10000,
      explain: true,
    });
    expect(results[0].breakdown?.outcomeBoost).toBeLessThan(1); // fast still live
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

  it('anchors decay at created: prior clock resets cannot leak in (codex round-3 P2)', () => {
    // Both memories created 30 days ago; one was "retrieved" 1 day ago by a
    // PRIOR unflagged run (persisted last_retrieved reset). Under the flag,
    // decay anchors at created, so both decay identically from creation.
    const created = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const reset = createMemory('clock reset by a prior run');
    reset.created = created;
    reset.last_retrieved = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    reset.half_life_days = 7;
    const untouched = createMemory('never retrieved');
    untouched.created = created;
    untouched.last_retrieved = created;
    untouched.half_life_days = 7;
    expect(calculateStrength(reset, NOW)).toBe(calculateStrength(untouched, NOW));
    // Sanity: WITHOUT the flag these differ (the reset memory is stronger).
    clearAblationEnv();
    expect(calculateStrength(reset, NOW)).toBeGreaterThan(calculateStrength(untouched, NOW));
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

  it('silences replay reward bias too: outcome counts no longer skew replay priority (codex P2)', async () => {
    // Replay (a consolidation sub-pass) preferentially rehearses
    // outcome-positive memories and then strengthens them via markRetrieved -
    // an outcome-dependent lifecycle path that must also go quiet in the
    // outcome-off arm.
    const { replayPriority } = await import('../src/replay.js');
    let rewarded = agedMemory(5, 'replay candidate');
    rewarded = applyOutcome(applyOutcome(rewarded, true), true);
    const plain = agedMemory(5, 'replay candidate');
    // Recompute BOTH strength caches at the same instant: replayPriority also
    // reads entry.strength, and applyOutcome's recompute-at-real-now would
    // otherwise differ from plain's initial cache purely by fixture timing.
    rewarded.strength = calculateStrength(rewarded, NOW);
    plain.strength = calculateStrength(plain, NOW);
    expect(replayPriority(rewarded, NOW)).toBe(replayPriority(plain, NOW));
    // Sanity: WITHOUT the flag the rewarded memory is prioritized.
    clearAblationEnv();
    rewarded.strength = calculateStrength(rewarded, NOW);
    plain.strength = calculateStrength(plain, NOW);
    expect(replayPriority(rewarded, NOW)).toBeGreaterThan(replayPriority(plain, NOW));
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
    // dated 2026 decays hard against the 2030 clock. (createMemory itself now
    // stamps fake time under the flag, so the 2026 dates are set explicitly.)
    const realFresh = createMemory('fresh in 2026');
    realFresh.created = '2026-06-11T00:00:00.000Z';
    realFresh.last_retrieved = '2026-06-11T00:00:00.000Z';
    realFresh.half_life_days = 7;
    expect(calculateStrength(realFresh)).toBeLessThan(0.01);
    // createMemory write-stamps honor the fake clock too (simulated sessions).
    expect(createMemory('stamped in 2030').created).toBe('2030-01-01T00:00:00.000Z');
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
    m.created = '2026-06-11T00:00:00.000Z'; // dated 2026, ancient against the 2030 clock
    m.last_retrieved = '2026-06-11T00:00:00.000Z';
    m.half_life_days = 7;
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

  it('rejects non-canonical formats Date.parse would accept (codex P2)', () => {
    // '1', locale dates, non-UTC ISO, millis-less forms, and ROLLED-OVER dates
    // (2026-02-31 silently becomes March 3 under V8 Date.parse) must NOT
    // become a fake clock - round-trip validation catches them all.
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
      process.env.HIPPO_FAKE_NOW = junk;
      _resetAblationCacheForTests();
      const drift = Math.abs(evalNow().getTime() - Date.now());
      expect(drift, `format '${junk}' must fall back to real clock`).toBeLessThan(5000);
    }
  });

  it('flows through the searchBothHybrid wrapper default too (codex P2)', async () => {
    // The wrapper destructures its own `now` default and passes it explicitly
    // into hybridSearch, so the inner fallback never runs - the wrapper default
    // itself must honor the fake clock.
    process.env.HIPPO_FAKE_NOW = '2030-01-01T00:00:00.000Z';
    _resetAblationCacheForTests();
    const { searchBothHybrid } = await import('../src/shared.js');
    const m = createMemory('wrapper clock consistency check');
    m.created = '2026-06-11T00:00:00.000Z'; // dated 2026, ancient against the 2030 clock
    m.last_retrieved = '2026-06-11T00:00:00.000Z';
    m.half_life_days = 7;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-abl-'));
    try {
      // Local-only store via the wrapper (global root nonexistent path).
      const { initStore, writeEntry } = await import('../src/store.js');
      initStore(tmp);
      writeEntry(tmp, m);
      const results = await searchBothHybrid('wrapper clock consistency check', tmp, path.join(tmp, 'no-global'), {
        budget: 10000,
        explain: true,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].breakdown?.strengthMultiplier).toBeLessThan(0.51);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('explicit now parameter always wins over the fake clock', () => {
    process.env.HIPPO_FAKE_NOW = '2030-01-01T00:00:00.000Z';
    _resetAblationCacheForTests();
    const m = agedMemory(0);
    expect(calculateStrength(m, NOW)).toBe(1.0); // explicit NOW, not 2030
  });
});
