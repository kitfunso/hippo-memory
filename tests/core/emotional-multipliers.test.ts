// J5 loss aversion: HIPPO_LOSS_AVERSION_RATIO scales only the negative multiplier, and a value under the 0.5 floor
// falls back to 1.0 so sleep never deletes an error-tagged memory for it. Each case sets the env var and reads strength
// through what a root builds from it.
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import {
  calculateStrength,
  createMemory,
  Layer,
  strengthOptionsOf,
  type EmotionalValence,
  type MemoryEntry,
  type StrengthOptions,
  DEFAULT_HALF_LIFE_DAYS,
} from '../../src/core/memory.js';
import { outcome, retrieve } from '../../src/api/index.js';
import { cliApiContext } from '../../src/cli/api-context.js';
import { envRuntimeSettings } from '../../src/util/env.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { readEntry, writeEntry } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// One instant for every entry age and strength call: two real-clock reads a pause apart moved a ratio past its tolerance.
const NOW = new Date();
const RATIO_ENV = 'HIPPO_LOSS_AVERSION_RATIO';

function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** The strength options a root builds once HIPPO_LOSS_AVERSION_RATIO reads `raw`. */
function underEnv(raw: string): StrengthOptions {
  vi.stubEnv(RATIO_ENV, raw);
  return strengthOptionsOf(envRuntimeSettings());
}

/** An entry 5 days past its last recall with a 3-day half-life: decay ~0.315 keeps every multiplier under the clamp. */
function makeEntry(valence: EmotionalValence, content = `test memory with valence ${valence}`): MemoryEntry {
  const e = createMemory(content, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    kind: 'raw',
    tenantId: 'default',
    emotionalValence: valence,
  });
  e.lastRetrieved = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  e.halfLifeDays = 3;
  return e;
}

/** Strength of `valence` under the ratio the env var names, over the same entry at ratio 1.0. */
function scaledOverBaseline(valence: EmotionalValence, raw: string): number {
  const e = makeEntry(valence);
  return calculateStrength(e, NOW, underEnv(raw)) / calculateStrength(e, NOW);
}

describe('EMOTIONAL_MULTIPLIERS defaults', () => {
  it('1. new defaults: positive=1.0, negative=2.0, critical=2.0, neutral=1.0', () => {
    const posStrength = calculateStrength(makeEntry('positive'), NOW);
    const negStrength = calculateStrength(makeEntry('negative'), NOW);
    const critStrength = calculateStrength(makeEntry('critical'), NOW);
    const neuStrength = calculateStrength(makeEntry('neutral'), NOW);
    expect(negStrength / posStrength).toBeCloseTo(2.0, 6);
    expect(critStrength).toBeCloseTo(negStrength, 6);
    expect(posStrength).toBeCloseTo(neuStrength, 6);
  });

  it('2. env var scaling: HIPPO_LOSS_AVERSION_RATIO=0.5 halves negative multiplier', () => {
    expect(scaledOverBaseline('negative', '0.5')).toBeCloseTo(0.5, 6);
  });

  it('3. env var off (no env set): defaults to 1.0 ratio (negative multiplier intact)', () => {
    const e = makeEntry('negative');
    vi.stubEnv(RATIO_ENV, undefined);
    const unset = calculateStrength(e, NOW, strengthOptionsOf(envRuntimeSettings()));
    expect(unset).toBeCloseTo(calculateStrength(e, NOW, underEnv('1.0')), 6);
  });

  it('4. env=0: REJECTED as invalid (below 0.5 floor), silent fallback to 1.0', () => {
    expect(scaledOverBaseline('negative', '0')).toBeCloseTo(1.0, 6);
  });

  describe('5. env invalid -> silent fallback to 1.0', () => {
    const invalidValues = [
      '',
      'abc',
      '0',
      '0.1',
      '0.25',
      '0.49',
      '-1',
      '-0.5',
      'NaN',
      'Infinity',
      '-Infinity',
      '1e1000',
    ];
    for (const v of invalidValues) {
      it(`5.${v || '(empty)'}: invalid value "${v}" falls back to ratio=1.0`, () => {
        expect(scaledOverBaseline('negative', v)).toBeCloseTo(1.0, 6);
      });
    }
  });

  // Number() is the parser, so whitespace, scientific notation and hex all count as numbers.
  describe('5b. env permissive parse semantics (Number() coercion)', () => {
    it('whitespace tolerated: " 0.5 " parses as 0.5', () => {
      expect(scaledOverBaseline('negative', ' 0.5 ')).toBeCloseTo(0.5, 6);
    });
    it('scientific notation tolerated: "1.5e0" parses as 1.5 (above 0.5 floor)', () => {
      expect(scaledOverBaseline('negative', '1.5e0')).toBeCloseTo(1.5, 6);
    });
    it('hex tolerated: "0x10" parses as 16 (then clamped at strength ceiling)', () => {
      const e = makeEntry('negative');
      expect(calculateStrength(e, NOW, underEnv('0x10'))).toBe(1.0);
      expect(calculateStrength(e, NOW)).toBeLessThan(1.0);
    });
  });

  it('6. negative-only invariant: env var does NOT affect positive multiplier', () => {
    expect(scaledOverBaseline('positive', '0.6')).toBeCloseTo(1.0, 6);
  });

  it('7. negative-only invariant: env var does NOT affect critical multiplier', () => {
    expect(scaledOverBaseline('critical', '0.6')).toBeCloseTo(1.0, 6);
  });

  it('8. negative-only invariant: env var does NOT affect neutral multiplier', () => {
    expect(scaledOverBaseline('neutral', '0.6')).toBeCloseTo(1.0, 6);
  });

  it('10. a ratio handed down as a number follows the same floor', () => {
    const e = makeEntry('negative');
    const baseline = calculateStrength(e, NOW);
    expect(calculateStrength(e, NOW, { lossAversionRatio: 1.5 }) / baseline).toBeCloseTo(1.5, 6);
    expect(calculateStrength(e, NOW, { lossAversionRatio: 0.5 }) / baseline).toBeCloseTo(0.5, 6);
    expect(calculateStrength(e, NOW, { lossAversionRatio: 0.1 })).toBeCloseTo(baseline, 6);
  });
});

describe('the CLI root reads the ratio into the store it builds', () => {
  /** The strength a bad outcome leaves on an aged negative entry, applied through the CLI's context under `raw`. */
  async function strengthAfterBadOutcome(raw: string): Promise<number> {
    vi.stubEnv(RATIO_ENV, raw);
    const root = makeRoot('j5-root');
    try {
      const entry = makeEntry('negative');
      writeEntry(root, entry);
      await outcome(cliApiContext(root, 'default'), [entry.id], false);
      return readEntry(root, entry.id)!.strength;
    } finally {
      safeRmSync(root);
    }
  }

  it('11. HIPPO_LOSS_AVERSION_RATIO=0.5 halves the strength an outcome writes', async () => {
    const scaled = await strengthAfterBadOutcome('0.5');
    const baseline = await strengthAfterBadOutcome('1.0');
    expect(baseline).toBeLessThan(1.0);
    // The outcome scores on the real clock, so the two writes are ms apart; 4 places allow seconds of drift.
    expect(scaled / baseline).toBeCloseTo(0.5, 4);
  });
});

describe('behavioral: env=0 ranking effect', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('j5-behavioral');
  });
  afterEach(() => {
    safeRmSync(root);
  });

  /** Recall's strength for the `negative` variant after seeding `valences` scored under `rules`. */
  async function recalledNegative(at: string, valences: EmotionalValence[], rules: StrengthOptions): Promise<number> {
    for (const valence of valences) {
      const e = makeEntry(valence, `shared ranking keyword variant ${valence} test`);
      e.strength = calculateStrength(e, NOW, rules);
      writeEntry(at, e);
    }
    const ctx: FullContext = apiCtx(at, 'default', { subject: 'test:j5-behavioral', role: 'admin' });
    const result = await retrieve(ctx, { query: 'shared ranking keyword variant test' });
    expect(result.results.length).toBeGreaterThanOrEqual(valences.length);
    const strength = result.results.find((r) => r.content.includes('variant negative test'))?.strength;
    expect(strength).toBeDefined();
    return strength!;
  }

  it('9. env=0.5 (the previous floor) reduces error-tagged memory strength vs default', async () => {
    // Recall returns the strength stored at write time, so the ratio shows in what the write scored.
    const negStrength = await recalledNegative(root, ['positive', 'negative', 'critical', 'neutral'], underEnv('0.5'));
    expect(negStrength).toBeGreaterThan(0.05);
    const root2 = makeRoot('j5-behavioral-baseline');
    try {
      expect(negStrength).toBeLessThan(await recalledNegative(root2, ['negative'], underEnv('1.0')));
    } finally {
      safeRmSync(root2);
    }
  });
});
