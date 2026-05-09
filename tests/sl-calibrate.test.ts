// tests/sl-calibrate.test.ts
import { describe, it, expect } from 'vitest';
import { selectBStar } from '../benchmarks/sequential-learning/calibrate.mjs';

import { mulberry32 } from '../benchmarks/sequential-learning/aggregate.mjs';

describe('v1.7.6 calibration B* selection', () => {
  it('picks the LARGEST budget where C2 late mean ∈ [0.04, 0.24] AND lower-CI > 0', () => {
    const candidates = [
      { budget: 200, lateMean: 0.30, lateCI: 0.05 }, // mean too high
      { budget: 400, lateMean: 0.20, lateCI: 0.05 }, // in band, lower-CI=0.15 > 0 ✓
      { budget: 600, lateMean: 0.10, lateCI: 0.05 }, // in band, lower-CI=0.05 > 0 ✓
      { budget: 800, lateMean: 0.05, lateCI: 0.06 }, // in band, lower-CI=-0.01 < 0 ✗
      { budget: 1000, lateMean: 0.02, lateCI: 0.01 }, // too low ✗
    ];
    const bStar = selectBStar(candidates);
    expect(bStar.budget).toBe(600); // largest passing
    expect(bStar.reason).toMatch(/in band/i);
  });

  it('returns null when no candidate qualifies', () => {
    const candidates = [
      { budget: 200, lateMean: 0.40, lateCI: 0.05 },
      { budget: 400, lateMean: 0.30, lateCI: 0.05 },
      { budget: 800, lateMean: 0.02, lateCI: 0.01 },
    ];
    const bStar = selectBStar(candidates);
    expect(bStar.budget).toBeNull();
    expect(bStar.reason).toMatch(/no candidate/i);
  });

  it('handles empty input', () => {
    expect(selectBStar([]).budget).toBeNull();
  });

  it('rejects candidate with mean exactly at boundary lower-CI=0', () => {
    // mean=0.04 with CI=0.04 → lower-CI = 0.0, NOT > 0, so reject.
    const candidates = [
      { budget: 400, lateMean: 0.04, lateCI: 0.04 },
    ];
    expect(selectBStar(candidates).budget).toBeNull();
  });

  // Post-review P1-10 — boundary positive case
  it('accepts candidate at lower band boundary with positive lower-CI', () => {
    // mean=0.04 with CI=0.039 → lower-CI = 0.001 > 0, accept.
    const candidates = [
      { budget: 400, lateMean: 0.04, lateCI: 0.039 },
    ];
    expect(selectBStar(candidates).budget).toBe(400);
  });

  // Post-review P1-10 — boundary negative case (mean below band)
  it('rejects candidate just below band even with zero CI', () => {
    // mean=0.0399 < BAND_LOW=0.04 → reject regardless of CI.
    const candidates = [
      { budget: 400, lateMean: 0.0399, lateCI: 0.0 },
    ];
    expect(selectBStar(candidates).budget).toBeNull();
  });

  // Post-review P1-1 — calibration vs hypothesis seed-stream non-collision
  it('calibration and hypothesis mulberry32 streams are pairwise distinct in first 50 draws', () => {
    // Hypothesis seeds: 1000 + i for i in 0..19
    const hypoSeeds = Array.from({ length: 20 }, (_, i) =>
      (Math.imul(0x9E3779B9, (1000 + i) >>> 0)) >>> 0,
    );
    // Calibration seeds (post-review P1-1 — bumped offset 100 → 10000): 1000 + 10000 + i for i in 0..9
    const calibSeeds = Array.from({ length: 10 }, (_, i) =>
      (Math.imul(0x9E3779B9, (1000 + 10000 + i) >>> 0)) >>> 0,
    );
    const allSeeds = [...hypoSeeds, ...calibSeeds];
    const draws = allSeeds.map((s) => {
      const rng = mulberry32(s);
      return Array.from({ length: 50 }, () => rng());
    });
    // Pairwise: no two seed streams produce identical first 50 draws.
    for (let i = 0; i < draws.length; i++) {
      for (let j = i + 1; j < draws.length; j++) {
        const same = draws[i].every((v, k) => v === draws[j][k]);
        expect(same).toBe(false);
      }
    }
  });
});
