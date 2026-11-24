import { describe, it, expect } from 'vitest';
import { selectBStar } from '../../benchmarks/sequential-learning/calibrate.mjs';

import { mulberry32 } from '../../scripts/lib/prng.mjs';

describe('calibration B* selection', () => {
  it('picks the LARGEST budget where C2 late mean ∈ [0.04, 0.24] AND lower-CI > 0', () => {
    const candidates = [
      { budget: 200, lateMean: 0.3, lateCI: 0.05 },
      { budget: 400, lateMean: 0.2, lateCI: 0.05 },
      { budget: 600, lateMean: 0.1, lateCI: 0.05 },
      { budget: 800, lateMean: 0.05, lateCI: 0.06 },
      { budget: 1000, lateMean: 0.02, lateCI: 0.01 },
    ];
    const bStar = selectBStar(candidates);
    expect(bStar.budget).toBe(600);
    expect(bStar.reason).toMatch(/in band/i);
  });

  it('returns null when no candidate qualifies', () => {
    const candidates = [
      { budget: 200, lateMean: 0.4, lateCI: 0.05 },
      { budget: 400, lateMean: 0.3, lateCI: 0.05 },
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
    const candidates = [{ budget: 400, lateMean: 0.04, lateCI: 0.04 }];
    expect(selectBStar(candidates).budget).toBeNull();
  });

  it('accepts candidate at lower band boundary with positive lower-CI', () => {
    const candidates = [{ budget: 400, lateMean: 0.04, lateCI: 0.039 }];
    expect(selectBStar(candidates).budget).toBe(400);
  });

  it('rejects candidate just below band even with zero CI', () => {
    const candidates = [{ budget: 400, lateMean: 0.0399, lateCI: 0.0 }];
    expect(selectBStar(candidates).budget).toBeNull();
  });

  it('skips a candidate flagged starved=true even when it would otherwise be selected', () => {
    const candidates = [
      { budget: 800, lateMean: 0.2, lateCI: 0.03, starved: true },
      { budget: 600, lateMean: 0.1, lateCI: 0.04, starved: false },
      { budget: 400, lateMean: 0.05, lateCI: 0.01, starved: false },
    ];
    const bStar = selectBStar(candidates);
    expect(bStar.budget).toBe(600);
    expect(bStar.reason).toMatch(/not starved/i);
  });

  it('reason string omits "(not starved)" when no candidate carries the flag', () => {
    const candidates = [
      { budget: 800, lateMean: 0.3, lateCI: 0.02 },
      { budget: 600, lateMean: 0.02, lateCI: 0.01 },
    ];
    const bStar = selectBStar(candidates);
    expect(bStar.budget).toBeNull();
    expect(bStar.reason).not.toMatch(/not starved/i);
  });

  it('calibration and hypothesis mulberry32 streams are pairwise distinct in first 50 draws', () => {
    const hypoSeeds = Array.from({ length: 20 }, (_, i) => Math.imul(0x9e3779b9, (1000 + i) >>> 0) >>> 0);
    const calibSeeds = Array.from({ length: 10 }, (_, i) => Math.imul(0x9e3779b9, (1000 + 10000 + i) >>> 0) >>> 0);
    const allSeeds = [...hypoSeeds, ...calibSeeds];
    const draws = allSeeds.map((s) => {
      const rng = mulberry32(s);
      return Array.from({ length: 50 }, () => rng());
    });
    for (let i = 0; i < draws.length; i++) {
      for (let j = i + 1; j < draws.length; j++) {
        const same = draws[i].every((v, k) => v === draws[j][k]);
        expect(same).toBe(false);
      }
    }
  });
});
