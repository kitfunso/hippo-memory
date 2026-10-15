/** Student t tests over repositories (Z0 Amendment 1): table quantiles, closed-form CDFs, the zero-spread rule,
 * one repository, and cluster-robust and Fieller ratio intervals worked by hand. */
import { describe, it, expect } from 'vitest';
import { clusterRatioT, fiellerRatioT, incompleteBeta, repositoryT, studentTCdf, studentTQuantile } from '../src/eval/repository-t.js';

// t(0.975, df) from printed tables, to six decimals.
const TABLE: readonly (readonly [number, number])[] = [[1, 12.706205], [2, 4.302653], [4, 2.776445], [9, 2.262157], [30, 2.042272]];

describe('Student t distribution', () => {
  it('matches table quantiles to at least 4 decimals', () => {
    for (const [df, t] of TABLE) {
      expect(studentTQuantile(0.975, df)).toBeCloseTo(t, 5);
      expect(studentTQuantile(0.025, df)).toBeCloseTo(-t, 5);
    }
    expect(studentTQuantile(0.995, 4)).toBeCloseTo(4.604095, 5);
    expect(() => studentTQuantile(1, 4)).toThrow(RangeError);
  });

  it('matches the closed-form CDF at 1, 2 and 3 degrees of freedom', () => {
    for (const t of [-3, -0.5, 0, 0.7, 2.5, 40]) {
      expect(studentTCdf(t, 1)).toBeCloseTo(0.5 + Math.atan(t) / Math.PI, 12);
      expect(studentTCdf(t, 2)).toBeCloseTo(0.5 + t / (2 * Math.sqrt(2 + t * t)), 12);
      const u = t / Math.sqrt(3);
      expect(studentTCdf(t, 3)).toBeCloseTo(0.5 + (u / (1 + u * u) + Math.atan(u)) / Math.PI, 12);
    }
  });

  it('gives the regularized incomplete beta its edge forms', () => {
    for (const x of [0.1, 0.5, 0.93]) {
      expect(incompleteBeta(x, 1, 1)).toBeCloseTo(x, 12);
      expect(incompleteBeta(x, 3, 1)).toBeCloseTo(x ** 3, 12);
    }
    expect([incompleteBeta(0, 2, 3), incompleteBeta(1, 2, 3)]).toEqual([0, 1]);
  });
});

describe('repositoryT', () => {
  it('is the one-sample t test on repository values, worked by hand at 3 degrees of freedom', () => {
    const r = repositoryT([0.1, 0.3, 0.2, 0.4]);
    const se = Math.sqrt(0.05 / 3) / 2;
    const u = 0.25 / se / Math.sqrt(3);
    expect([r.estimate, r.se, r.df, r.nullValue, r.iterations, r.dropped]).toEqual([expect.closeTo(0.25, 12), expect.closeTo(se, 12), 3, 0, 0, 0]);
    expect(r.p).toBeCloseTo(1 - (2 * (u / (1 + u * u) + Math.atan(u))) / Math.PI, 12);
    expect([r.low, r.high]).toEqual([expect.closeTo(0.25 - 3.182446 * se, 5), expect.closeTo(0.25 + 3.182446 * se, 5)]);
  });

  it('collapses the interval with no spread: p is 1 on the null and 0 off it, float noise included', () => {
    expect(repositoryT([0, 0, 0])).toMatchObject({ estimate: 0, low: 0, high: 0, p: 1, se: 0, df: 2 });
    const off = repositoryT([0.1, 0.1, 0.1]);
    expect([off.low, off.high, off.p, off.se]).toEqual([off.estimate, off.estimate, 0, 0]);
    expect(off.estimate).toBeCloseTo(0.1, 15);
    expect(repositoryT([2, 2], 2).p).toBe(1);
  });

  it('gives the not-a-number result for fewer than two repositories', () => {
    for (const r of [repositoryT([0.4]), repositoryT([]), clusterRatioT([{ t: 2, c: 1 }]), fiellerRatioT([{ t: 2, c: 1 }])]) {
      expect([r.estimate, r.low, r.high, r.p].every(Number.isNaN)).toBe(true);
    }
  });
});

describe('ratio intervals', () => {
  const repos = [{ t: 2, c: 2 }, { t: 3, c: 2 }, { t: 7, c: 6 }];

  it('clusterRatioT: pooled ratio 12/10, residuals -0.4, 0.6, -0.2, se sqrt(1.5 x 0.56) / 10, df 2', () => {
    const r = clusterRatioT(repos);
    const se = Math.sqrt(1.5 * 0.56) / 10;
    const t = 0.2 / se;
    expect([r.estimate, r.se, r.df, r.nullValue]).toEqual([1.2, expect.closeTo(se, 12), 2, 1]);
    expect(r.p).toBeCloseTo(1 - t / Math.sqrt(2 + t * t), 12);
    expect([r.low, r.high]).toEqual([expect.closeTo(1.2 - 4.302653 * se, 5), expect.closeTo(1.2 + 4.302653 * se, 5)]);
  });

  it('fiellerRatioT: each bound is a ratio whose repository differences sit exactly at p 0.05', () => {
    const steady = [{ t: 2.4, c: 2 }, { t: 2.6, c: 2.5 }, { t: 3.9, c: 3 }, { t: 3.1, c: 2.5 }];
    const r = fiellerRatioT(steady);
    const at = (ratio: number) => repositoryT(steady.map((x) => x.t - ratio * x.c)).p;
    expect([r.estimate, r.df, r.nullValue]).toEqual([expect.closeTo(1.2, 12), 3, 1]);
    expect(Number.isFinite(r.low) && Number.isFinite(r.high) && r.low < r.estimate && r.estimate < r.high).toBe(true);
    expect([at(r.low), at(r.high)]).toEqual([expect.closeTo(0.05, 9), expect.closeTo(0.05, 9)]);
    expect([at(r.low + 1e-6), at(r.high - 1e-6)].every((p) => p > 0.05)).toBe(true);
    expect(r.p).toBe(at(1));
    // Controls of 2, 2 and 6 over 2 df are not clear of zero, so the same set with the first three is unbounded.
    expect(fiellerRatioT(repos).high).toBe(Number.POSITIVE_INFINITY);
  });

  it('fiellerRatioT: unbounded when the control sums are not clear of zero, a point with no spread', () => {
    const loose = fiellerRatioT([{ t: 1, c: 1 }, { t: 12, c: 10 }, { t: 0.2, c: 0.1 }]);
    expect([loose.low, loose.high]).toEqual([Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]);
    const flat = fiellerRatioT([{ t: 2.2, c: 2 }, { t: 2.2, c: 2 }, { t: 2.2, c: 2 }]);
    expect([flat.low, flat.high]).toEqual([expect.closeTo(1.1, 9), expect.closeTo(1.1, 9)]);
    expect(flat.p).toBe(0);
  });
});
