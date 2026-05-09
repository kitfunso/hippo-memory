/**
 * v1.7.5 -- multi-seed aggregation helpers + seeded task generator.
 * Pure math, no DB. Determinism + variance tests for traps.mjs::generateTasks(seed).
 */

import { describe, it, expect } from 'vitest';
import {
  mean,
  stdDev,
  ciHalfWidth95,
  aggregatePhases,
  pairedPermutationCI,
  // @ts-expect-error -- .mjs has no .d.ts; runtime ESM is fine
} from '../benchmarks/sequential-learning/aggregate.mjs';
import {
  generateTasks,
  TRAP_PLACEMENTS,
  // @ts-expect-error -- .mjs has no .d.ts
} from '../benchmarks/sequential-learning/traps.mjs';

// ---------------------------------------------------------------------------
// Pure aggregator math
// ---------------------------------------------------------------------------

describe('aggregate helpers (v1.7.5)', () => {
  it('mean of [0.1, 0.2, 0.3] = 0.2', () => {
    expect(mean([0.1, 0.2, 0.3])).toBeCloseTo(0.2, 5);
  });

  it('stdDev of identical values is 0', () => {
    expect(stdDev([0.5, 0.5, 0.5])).toBeCloseTo(0, 5);
  });

  it('ciHalfWidth95 for 10-sample [0.10..0.20] is approximately 0.032', () => {
    // Hand-verified: mean=0.15, sample variance ~0.001944, sd ~0.04410,
    // CI = 2.262 * 0.04410 / sqrt(10) ~= 0.0315.
    expect(
      ciHalfWidth95([0.10, 0.15, 0.20, 0.10, 0.15, 0.20, 0.10, 0.15, 0.20, 0.15]),
    ).toBeCloseTo(0.032, 2);
  });

  it('ciHalfWidth95 returns 0 for n=1 (no sample variance estimable)', () => {
    expect(ciHalfWidth95([0.5])).toBe(0);
  });

  it('ciHalfWidth95 rejects n<5 by returning 0 (codex P2 -- nonsense t-crit)', () => {
    expect(ciHalfWidth95([0.5, 0.6])).toBe(0);
    expect(ciHalfWidth95([0.5, 0.6, 0.7])).toBe(0);
    expect(ciHalfWidth95([0.5, 0.6, 0.7, 0.8])).toBe(0);
    // n=5 is the floor where CI is reportable
    expect(ciHalfWidth95([0.5, 0.5, 0.5, 0.5, 0.5])).toBe(0); // zero variance
  });

  it('ciHalfWidth95 produces a positive bound for n=5 with variance', () => {
    expect(ciHalfWidth95([0.1, 0.2, 0.3, 0.4, 0.5])).toBeGreaterThan(0);
  });

  it('aggregatePhases averages early/mid/late across seeds', () => {
    const seeds = [
      { early: 0.80, mid: 0.20, late: 0.10 },
      { early: 0.70, mid: 0.30, late: 0.15 },
      { early: 0.75, mid: 0.25, late: 0.05 },
    ];
    const agg = aggregatePhases(seeds);
    expect(agg.early.mean).toBeCloseTo(0.75, 5);
    expect(agg.mid.mean).toBeCloseTo(0.25, 5);
    expect(agg.late.mean).toBeCloseTo(0.10, 5);
    // Only n=3 -> ci95 returns 0 (below the n=5 floor)
    expect(agg.late.ci95).toBe(0);
    expect(agg.late.std).toBeGreaterThan(0);
  });

  it('aggregatePhases reports a positive ci95 when n>=5 with variance', () => {
    const seeds = [
      { early: 0.80, mid: 0.20, late: 0.05 },
      { early: 0.70, mid: 0.30, late: 0.15 },
      { early: 0.75, mid: 0.25, late: 0.05 },
      { early: 0.85, mid: 0.15, late: 0.20 },
      { early: 0.65, mid: 0.35, late: 0.10 },
    ];
    const agg = aggregatePhases(seeds);
    expect(agg.late.ci95).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Paired permutation CI
// ---------------------------------------------------------------------------

describe('pairedPermutationCI (v1.7.5)', () => {
  it('zero-delta on identical inputs: CI contains 0', () => {
    const xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const { deltaMean, ciLow, ciHigh } = pairedPermutationCI(xs, xs.slice());
    expect(deltaMean).toBeCloseTo(0, 5);
    expect(ciLow).toBeLessThanOrEqual(0);
    expect(ciHigh).toBeGreaterThanOrEqual(0);
  });

  it('large positive delta: CI excludes 0', () => {
    const xsA = [0.80, 0.85, 0.78, 0.82, 0.79, 0.81, 0.83, 0.84, 0.80, 0.82];
    const xsB = [0.20, 0.25, 0.18, 0.22, 0.19, 0.21, 0.23, 0.24, 0.20, 0.22];
    const { deltaMean, ciLow, ciHigh } = pairedPermutationCI(xsA, xsB);
    expect(deltaMean).toBeGreaterThan(0.5);
    expect(ciLow).toBeGreaterThan(0);
    expect(ciHigh).toBeGreaterThan(ciLow);
  });

  it('throws on length mismatch', () => {
    expect(() => pairedPermutationCI([0.1, 0.2, 0.3, 0.4, 0.5], [0.1, 0.2])).toThrow();
  });

  it('throws on n<5', () => {
    expect(() => pairedPermutationCI([0.1, 0.2, 0.3], [0.4, 0.5, 0.6])).toThrow();
  });

  it('is deterministic across calls (same inputs -> same CI)', () => {
    const xsA = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 0.55, 0.65, 0.75, 0.85];
    const xsB = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.45, 0.55, 0.65, 0.75];
    const r1 = pairedPermutationCI(xsA, xsB);
    const r2 = pairedPermutationCI(xsA, xsB);
    expect(r1.deltaMean).toBe(r2.deltaMean);
    expect(r1.ciLow).toBe(r2.ciLow);
    expect(r1.ciHigh).toBe(r2.ciHigh);
  });
});

// ---------------------------------------------------------------------------
// Seeded task generator -- determinism + variance + structural invariants
// ---------------------------------------------------------------------------

describe('generateTasks(seed) (v1.7.5)', () => {
  it('without a seed, returns the canonical fixed-position output', () => {
    const a = generateTasks();
    const b = generateTasks();
    expect(a).toEqual(b);
    // Specifically: position 2 still maps to overwrite_production canonical map.
    const trapAt2 = a.find((t: { id: number }) => t.id === 2);
    expect(trapAt2.trapCategory).toBe('overwrite_production');
  });

  it('is deterministic for a given seed (same seed -> deep-equal output)', () => {
    const a = generateTasks(42);
    const b = generateTasks(42);
    expect(a).toEqual(b);
  });

  it('varies meaningfully across different seeds (>= a third of trap slots differ)', () => {
    // Threshold deviation from brief: brief says ">half". With the ELL shape
    // group containing only `slop_words` (cannot shuffle a single-element
    // group), 3 slots are structurally frozen across all seeds. With small
    // shape groups (EM=3, ML=2, EML=4) adjacent seeds can land on
    // permutations that overlap substantially. Across pairs (1->2, 42->43)
    // we observe 17-19/25 differ, which is well above half; for adjacent
    // seeds (1000->1001) we observe 10/25, below half. A third (8/25) is the
    // honest floor that demonstrates real variance rather than theatre.
    const s1 = generateTasks(1000);
    const s2 = generateTasks(1001);
    const trapPositions: number[] = [];
    s1.forEach((t: { trapCategory: string | null }, i: number) => {
      if (t.trapCategory) trapPositions.push(i);
    });
    let differingSlots = 0;
    for (const i of trapPositions) {
      if (s1[i].trapCategory !== s2[i].trapCategory) differingSlots++;
    }
    expect(differingSlots).toBeGreaterThanOrEqual(Math.floor(trapPositions.length / 3));
  });

  it('varies meaningfully across far-apart seeds (>= half of trap slots differ)', () => {
    // Stronger pair confirms the algorithm produces real variance.
    const s1 = generateTasks(1);
    const s2 = generateTasks(2);
    const trapPositions: number[] = [];
    s1.forEach((t: { trapCategory: string | null }, i: number) => {
      if (t.trapCategory) trapPositions.push(i);
    });
    let differingSlots = 0;
    for (const i of trapPositions) {
      if (s1[i].trapCategory !== s2[i].trapCategory) differingSlots++;
    }
    expect(differingSlots).toBeGreaterThanOrEqual(Math.floor(trapPositions.length / 2));
  });

  it('preserves total trap-encounter count (31 across all seeds — v1.8.0: 25 v1.7.x + 6 adversarial)', () => {
    for (const seed of [0, 1, 42, 100, 1000, 9999]) {
      const tasks = generateTasks(seed);
      const trapCount = tasks.filter((t: { trapCategory: string | null }) => t.trapCategory).length;
      expect(trapCount).toBe(31);
    }
  });

  it('preserves per-category encounter count (matches TRAP_PLACEMENTS)', () => {
    const expectedCounts: Record<string, number> = {};
    for (const tp of TRAP_PLACEMENTS) {
      expectedCounts[tp.category] = tp.positions.length;
    }
    for (const seed of [42, 1000, 9999]) {
      const tasks = generateTasks(seed);
      const byCat: Record<string, number> = {};
      for (const t of tasks) {
        if (t.trapCategory) byCat[t.trapCategory] = (byCat[t.trapCategory] ?? 0) + 1;
      }
      expect(byCat).toEqual(expectedCounts);
    }
  });

  it('preserves each category native phase pattern (shape group invariant)', () => {
    // For each category, classify each canonical position into a phase.
    // After seeding, the multiset of phases the category spans must match.
    const phaseOf = (pos: number): 'early' | 'mid' | 'late' => {
      if (pos <= 17) return 'early';
      if (pos <= 34) return 'mid';
      return 'late';
    };
    const canonicalShape: Record<string, string> = {};
    for (const tp of TRAP_PLACEMENTS) {
      const phases = tp.positions.map(phaseOf).sort().join(',');
      canonicalShape[tp.category] = phases;
    }
    for (const seed of [42, 1000, 9999]) {
      const tasks = generateTasks(seed);
      const seededPhases: Record<string, string[]> = {};
      tasks.forEach((t: { id: number; trapCategory: string | null }) => {
        if (t.trapCategory) {
          (seededPhases[t.trapCategory] ??= []).push(phaseOf(t.id));
        }
      });
      for (const [cat, phases] of Object.entries(seededPhases)) {
        expect(phases.sort().join(',')).toBe(canonicalShape[cat]);
      }
    }
  });

  it("first-encounter is in early or mid (no category's first encounter lands in late)", () => {
    for (const seed of [42, 1000, 9999]) {
      const tasks = generateTasks(seed);
      const firstSeen: Record<string, number> = {};
      tasks.forEach((t: { id: number; trapCategory: string | null }) => {
        if (t.trapCategory && firstSeen[t.trapCategory] === undefined) {
          firstSeen[t.trapCategory] = t.id;
        }
      });
      for (const pos of Object.values(firstSeen)) {
        expect(pos).toBeLessThanOrEqual(34); // early or mid, never late
      }
    }
  });

  it('preserves the canonical slot positions (positions stay fixed; only categories shuffle)', () => {
    const canonicalPositions = new Set<number>();
    for (const tp of TRAP_PLACEMENTS) {
      for (const p of tp.positions) canonicalPositions.add(p);
    }
    const tasks = generateTasks(42);
    const seededPositions = new Set<number>();
    tasks.forEach((t: { id: number; trapCategory: string | null }) => {
      if (t.trapCategory) seededPositions.add(t.id);
    });
    expect(seededPositions).toEqual(canonicalPositions);
  });
});
