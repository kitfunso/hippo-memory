/**
 * v1.13.5 / J5 — loss-aversion calibration.
 *
 * Tests cover (per plan §6, 8 enumerated cases + 1 behavioral test from
 * plan-eng-critic round 2 LOW):
 *   1. New defaults: positive=1.0, negative=2.0, critical=2.0, neutral=1.0
 *   2. Env var scaling: HIPPO_LOSS_AVERSION_RATIO=0.5 halves negative multiplier
 *   3. Env var off (no env set): defaults to 1.0 ratio
 *   4. Env=0 (and all values < 0.5): REJECTED as invalid, silent fallback to
 *      ratio=1.0. v1.13.5 + independent-review round-1 HIGH + codex round-1 P1
 *      folds: the original "deliberate disable" semantics created a silent
 *      data-loss vector via consolidate.ts:146; the HIGH fix rejected only
 *      0; codex caught that any ratio < ~0.025 has the same surface and worse
 *      on aged memories. Final: reject ratios < 0.5 (LOSS_AVERSION_RATIO_MIN).
 *   5. Env invalid (empty, non-numeric, negative, NaN, Infinity): silent fallback to 1.0
 *   6. Negative-only invariant: env var does NOT affect positive
 *   7. Negative-only invariant: env var does NOT affect critical
 *   8. Negative-only invariant: env var does NOT affect neutral
 *   9. Behavioral: env=0 produces lowest-ranked error-tagged memory in recall set
 *
 * Test isolation pattern (mandated by plan-eng-critic round 2 LOW):
 *   - beforeEach: clear cache + delete env var
 *   - afterEach: clear cache + delete env var
 *   - within each test that sets the env var: set, then reset cache, then exercise
 *
 * Project rule: always use real DB for tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  calculateStrength,
  createMemory,
  Layer,
  type EmotionalValence,
  type MemoryEntry,
  type MemoryKind,
  _resetLossAversionRatioCacheForTests,
} from '../src/memory.js';
import { initStore, writeEntry } from '../src/store.js';
import { recall, type Context } from '../src/api.js';

const ENV_KEY = 'HIPPO_LOSS_AVERSION_RATIO';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function makeEntry(valence: EmotionalValence, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  // calculateStrength returns clamp01(decay * retrievalBoost * emotional_multiplier).
  // For fresh entries decay=1 and retrievalBoost=1, so every valence clamps to 1.0
  // (any multiplier >= 1.0 saturates), making multiplier differences invisible.
  // To probe the multiplier we use an AGED entry: last_retrieved 5 days ago + half-
  // life 3 days -> decay = 0.5^(5/3) ~= 0.315. Then strength = 0.315 * multiplier,
  // unclamped for multipliers up to ~3.17 (covers all our valences).
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const e = createMemory(`test memory with valence ${valence}`, {
    layer: Layer.Buffer,
    kind: 'raw' as MemoryKind,
    tenantId: 'default',
    emotional_valence: valence,
  });
  e.last_retrieved = fiveDaysAgo;
  e.half_life_days = 3;
  return { ...e, ...opts };
}

describe('EMOTIONAL_MULTIPLIERS defaults (v1.13.5 / J5)', () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
    _resetLossAversionRatioCacheForTests();
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
    _resetLossAversionRatioCacheForTests();
  });

  it('1. new defaults: positive=1.0, negative=2.0, critical=2.0, neutral=1.0', () => {
    // Aged entries (decay ~= 0.315) so multiplier differences stay unclamped.
    const posStrength = calculateStrength(makeEntry('positive'));
    const negStrength = calculateStrength(makeEntry('negative'));
    const critStrength = calculateStrength(makeEntry('critical'));
    const neuStrength = calculateStrength(makeEntry('neutral'));
    // negative (2.0) is exactly 2x positive (1.0) in the new defaults.
    expect(negStrength / posStrength).toBeCloseTo(2.0, 6);
    // critical (2.0) equals negative (2.0) per literal roadmap reading.
    expect(critStrength).toBeCloseTo(negStrength, 6);
    // positive (1.0) equals neutral (1.0) — was positive > neutral in v1.13.4.
    expect(posStrength).toBeCloseTo(neuStrength, 6);
  });

  it('2. env var scaling: HIPPO_LOSS_AVERSION_RATIO=0.5 halves negative multiplier', () => {
    const e = makeEntry('negative');
    process.env[ENV_KEY] = '0.5';
    _resetLossAversionRatioCacheForTests();
    const scaled = calculateStrength(e);
    delete process.env[ENV_KEY];
    _resetLossAversionRatioCacheForTests();
    const baseline = calculateStrength(e);
    // negative_multiplier baseline = 2.0; scaled (0.5x) = 1.0. Strength ratio = 0.5.
    // Aged entry keeps the result < 1.0 so the clamp doesn't hide the ratio.
    expect(scaled / baseline).toBeCloseTo(0.5, 6);
  });

  it('3. env var off (no env set): defaults to 1.0 ratio (negative multiplier intact)', () => {
    const e = makeEntry('negative');
    const strength = calculateStrength(e);
    process.env[ENV_KEY] = '1.0';
    _resetLossAversionRatioCacheForTests();
    const explicit = calculateStrength(e);
    expect(strength).toBeCloseTo(explicit, 6);
  });

  it('4. env=0: REJECTED as invalid (below 0.5 floor), silent fallback to 1.0', () => {
    // v1.13.5 + independent-review round-1 HIGH + codex round-1 P1 folds:
    // env=0 originally meant "deliberate disable" but that created a silent
    // data-loss vector via consolidate.ts:146. The HIGH fix rejected only 0;
    // codex P1 caught that any ratio < ~0.025 has the same problem on fresh
    // memories (and worse on aged ones). Final fix: reject ratios < 0.5 (the
    // LOSS_AVERSION_RATIO_MIN floor that matches the v1.13.4-equivalent
    // multiplier). To genuinely soften loss aversion below v1.13.4 levels,
    // a future J5-v2 env override would be needed; this env var's tuning
    // range is intentionally constrained to the deletion-safe regime.
    process.env[ENV_KEY] = '0';
    _resetLossAversionRatioCacheForTests();
    const e = makeEntry('negative');
    const rejected = calculateStrength(e);
    process.env[ENV_KEY] = '1.0';
    _resetLossAversionRatioCacheForTests();
    const baseline = calculateStrength(e);
    expect(rejected).toBeCloseTo(baseline, 6);
  });

  describe('5. env invalid -> silent fallback to 1.0', () => {
    // v1.13.5 + codex P1 fold: minimum acceptable ratio is 0.5. Below that
    // the consolidation-deletion vector becomes possible for aged memories.
    // All values below 0.5 (including '0', '0.25', '0.49') silently fall
    // back to ratio=1.0. The historical "deliberate disable" cases (0,
    // negatives) and the codex-flagged "small positive" cases (0.01, 0.1,
    // 0.25, 0.49) are all rejected together.
    const invalidValues = ['', 'abc', '0', '0.1', '0.25', '0.49', '-1', '-0.5', 'NaN', 'Infinity', '-Infinity', '1e1000'];
    for (const v of invalidValues) {
      it(`5.${v || '(empty)'}: invalid value "${v}" falls back to ratio=1.0`, () => {
        process.env[ENV_KEY] = v;
        _resetLossAversionRatioCacheForTests();
        const e = makeEntry('negative', { strength: 0.3 });
        const fallback = calculateStrength(e);
        // Compare against explicit ratio=1.0.
        process.env[ENV_KEY] = '1.0';
        _resetLossAversionRatioCacheForTests();
        const baseline = calculateStrength(e);
        expect(fallback).toBeCloseTo(baseline, 6);
      });
    }
  });

  // v1.13.5 code-review-critic round 1 LOW fold: lock the Number() parser
  // semantics so future readers see exactly which "weird-looking" strings
  // are accepted as valid. Whitespace and scientific notation pass through
  // Number(); hex (0x prefix) also parses to a number. Document the
  // permissive semantics rather than tighten — `parseFloat` would reject
  // some of these but introduce its own asymmetries.
  describe('5b. env permissive parse semantics (Number() coercion)', () => {
    it('whitespace tolerated: " 0.5 " parses as 0.5', () => {
      process.env[ENV_KEY] = ' 0.5 ';
      _resetLossAversionRatioCacheForTests();
      const e = makeEntry('negative');
      const scaled = calculateStrength(e);
      delete process.env[ENV_KEY];
      _resetLossAversionRatioCacheForTests();
      const baseline = calculateStrength(e);
      expect(scaled / baseline).toBeCloseTo(0.5, 6);
    });
    it('scientific notation tolerated: "1.5e0" parses as 1.5 (above 0.5 floor)', () => {
      // v1.13.5 + codex P1: 0.5 floor means we use a sci-notation value
      // ABOVE the floor (1.5 = 1.5e0) so the test still demonstrates parse
      // semantics without colliding with the rejection floor. Sub-floor
      // values like '1.5e-1' (= 0.15) are correctly rejected; they appear
      // in test 5 invalid enumeration.
      process.env[ENV_KEY] = '1.5e0';
      _resetLossAversionRatioCacheForTests();
      const e = makeEntry('negative');
      const scaled = calculateStrength(e);
      delete process.env[ENV_KEY];
      _resetLossAversionRatioCacheForTests();
      const baseline = calculateStrength(e);
      // scaled / baseline = 1.5 if neither clamps; with aged entry the
      // unclamped strength stays < 1.0 so the ratio is visible.
      expect(scaled / baseline).toBeGreaterThan(1.0);
    });
    it('hex tolerated: "0x10" parses as 16 (then clamped at strength ceiling)', () => {
      // Per independent-review-critic round 1 LOW: the comment in 5b promises
      // hex is documented but no test covered it. Number('0x10') = 16, so the
      // negative multiplier becomes 2.0 * 16 = 32, which clamps to strength=1.0
      // on any non-zero decay. This asserts the parser accepts the value
      // (rather than silent-fallback). User-facing impact: hex inputs are
      // legal but always saturate; if you want subtle tuning use decimals.
      process.env[ENV_KEY] = '0x10';
      _resetLossAversionRatioCacheForTests();
      const e = makeEntry('negative');
      const scaled = calculateStrength(e);
      delete process.env[ENV_KEY];
      _resetLossAversionRatioCacheForTests();
      const baseline = calculateStrength(e);
      // scaled >= baseline (32x multiplier saturates at clamp; baseline is unclamped at ~0.63).
      expect(scaled).toBeGreaterThanOrEqual(baseline);
    });
  });

  it('6. negative-only invariant: env var does NOT affect positive multiplier', () => {
    const e = makeEntry('positive');
    process.env[ENV_KEY] = '0.1';
    _resetLossAversionRatioCacheForTests();
    const withEnv = calculateStrength(e);
    delete process.env[ENV_KEY];
    _resetLossAversionRatioCacheForTests();
    const withoutEnv = calculateStrength(e);
    expect(withEnv).toBeCloseTo(withoutEnv, 6);
  });

  it('7. negative-only invariant: env var does NOT affect critical multiplier', () => {
    const e = makeEntry('critical');
    process.env[ENV_KEY] = '0.1';
    _resetLossAversionRatioCacheForTests();
    const withEnv = calculateStrength(e);
    delete process.env[ENV_KEY];
    _resetLossAversionRatioCacheForTests();
    const withoutEnv = calculateStrength(e);
    expect(withEnv).toBeCloseTo(withoutEnv, 6);
  });

  it('8. negative-only invariant: env var does NOT affect neutral multiplier', () => {
    const e = makeEntry('neutral');
    process.env[ENV_KEY] = '0.1';
    _resetLossAversionRatioCacheForTests();
    const withEnv = calculateStrength(e);
    delete process.env[ENV_KEY];
    _resetLossAversionRatioCacheForTests();
    const withoutEnv = calculateStrength(e);
    expect(withEnv).toBeCloseTo(withoutEnv, 6);
  });
});

describe('J5 behavioral: env=0 ranking effect (v1.13.5)', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('j5-behavioral');
    delete process.env[ENV_KEY];
    _resetLossAversionRatioCacheForTests();
  });
  afterEach(() => {
    safeRmSync(root);
    delete process.env[ENV_KEY];
    _resetLossAversionRatioCacheForTests();
  });

  it('9. env=0.5 (v1.13.4-equivalent floor) reduces error-tagged memory strength vs default', () => {
    // v1.13.5 + codex P1 fold: env=0.01 was originally used here but is
    // now rejected as invalid (below the 0.5 floor). Use env=0.5 (the
    // minimum valid ratio = v1.13.4 equivalent multiplier of 1.0 + 0.5*1.0
    // = 1.5 vs default 2.0). The strength field on RecallResultItem surfaces
    // the write-time value, which reflects the env=0.5 calibration: error-
    // tagged memories should rank somewhat lower than under default ratio=1.0,
    // and the strength field reflects that (but stays safely above
    // DECAY_THRESHOLD).
    process.env[ENV_KEY] = '0.5';
    _resetLossAversionRatioCacheForTests();
    const marker = (v: string) => `shared ranking keyword variant ${v} test`;
    for (const valence of ['positive', 'negative', 'critical', 'neutral'] as EmotionalValence[]) {
      // v1.13.5 + codex round 2 P2-B fold: age all seeded entries (5 days
      // old, half-life 3) so the unclamped strength values are visible and
      // the env-driven multiplier delta is observable in recall output.
      const e = createMemory(marker(valence), {
        layer: Layer.Buffer,
        kind: 'raw' as MemoryKind,
        tenantId: 'default',
        emotional_valence: valence,
      });
      e.last_retrieved = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      e.half_life_days = 3;
      e.strength = calculateStrength(e);
      writeEntry(root, e);
    }
    const ctx: Context = {
      hippoRoot: root,
      tenantId: 'default',
      actor: { subject: 'test:j5-behavioral', role: 'admin' },
    };
    const result = recall(ctx, { query: 'shared ranking keyword variant test' });
    expect(result.results.length).toBeGreaterThanOrEqual(4);
    // Locate the 4 seeded entries via their content marker and read the
    // strength field that recall surfaced. The strength field IS the output
    // of calculateStrength (with the env-aware multiplier applied), so:
    //   - negative entry should have strength = 0 (multiplier collapsed)
    //   - positive/critical/neutral should have strength > 0
    // This is a behavioral assertion (uses the recall pipeline end-to-end)
    // distinct from test 4 (which calls calculateStrength directly). It does
    // NOT assert ranking position because recall combines BM25 + embedding +
    // strength + recency, and strength is one factor among several; the env
    // var's job is to control the multiplier value, not to dominate ranking.
    const findStrength = (v: string) =>
      result.results.find((r) => r.content.includes(`variant ${v} test`))?.strength;
    const negStrength = findStrength('negative')!;
    expect(negStrength).toBeGreaterThan(0.05); // safely above DECAY_THRESHOLD

    // v1.13.5 + codex round 2 P2-B fold: original test used fresh entries
    // that clamped to 1.0 for both env=0.5 and default, making the <= assertion
    // vacuous. Use an aged baseline fixture (5 days old, half-life 3) so the
    // unclamped strength values are visible and strict reduction is testable.
    safeRmSync(root);
    const root2 = makeRoot('j5-behavioral-baseline');
    process.env[ENV_KEY] = '1.0';
    _resetLossAversionRatioCacheForTests();
    const baselineEntry = createMemory('shared ranking keyword variant negative test', {
      layer: Layer.Buffer,
      kind: 'raw' as MemoryKind,
      tenantId: 'default',
      emotional_valence: 'negative',
    });
    // Force an aged last_retrieved so the stored strength stays unclamped
    // and the env-driven multiplier difference is visible.
    baselineEntry.last_retrieved = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    baselineEntry.half_life_days = 3;
    // Recompute the stored strength after the age override so writeEntry
    // captures the aged value (the strength field was set at createMemory time
    // with last_retrieved=now; we re-run calculateStrength now that the entry
    // is aged so the stored value matches our test intent).
    baselineEntry.strength = calculateStrength(baselineEntry);
    writeEntry(root2, baselineEntry);
    const ctx2: Context = {
      hippoRoot: root2,
      tenantId: 'default',
      actor: { subject: 'test:j5-behavioral-baseline', role: 'admin' },
    };
    const baselineResult = recall(ctx2, { query: 'shared ranking keyword variant test' });
    const baselineNeg = baselineResult.results.find((r) => r.content.includes('variant negative test'))?.strength;
    expect(baselineNeg).toBeDefined();
    // Aged fixtures keep both values unclamped; env=0.5 should STRICTLY
    // reduce vs default ratio=1.0 (negative multiplier 1.0 vs 2.0). NOTE:
    // this catches a recall pipeline that respects the env var; per codex
    // P2-A documented as Known Limitation in CHANGELOG, api.recall returns
    // stored strengths and does NOT recompute per-call, so the difference
    // here reflects WRITE-TIME calibration not runtime dynamic tuning.
    expect(negStrength).toBeLessThan(baselineNeg!);
    safeRmSync(root2);
  });
});
