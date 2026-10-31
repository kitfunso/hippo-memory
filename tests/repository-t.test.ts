/** Student t tests over repositories (Z0 Amendment 1): table quantiles, closed-form CDFs, the zero-spread rule,
 * one repository, and cluster-robust and Cox ratio intervals worked by hand. */
import { describe, it, expect } from 'vitest';
import { clusterRatioT, coxRatioT, incompleteBeta, repositoryT, studentTCdf, studentTQuantile } from '../src/eval/repository-t.js';

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
    for (const r of [repositoryT([0.4]), repositoryT([]), clusterRatioT([{ t: 2, c: 1 }]), coxRatioT([{ t: 2, c: 1 }])]) {
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

  it('coxRatioT: log ratios -0.2 above and below 0.2 give centre 0.22, se sqrt(0.04 / 3 + 0.0016 / 4), df 2', () => {
    const r = coxRatioT([0, 0.2, 0.4].map((y) => ({ t: 2 * Math.exp(y), c: 2 })));
    const se = Math.sqrt(0.04 / 3 + 0.0016 / 4);
    const t = 0.22 / se;
    expect([r.estimate, r.se, r.df, r.nullValue]).toEqual([expect.closeTo(Math.exp(0.22), 12), expect.closeTo(se, 12), 2, 1]);
    expect(r.p).toBeCloseTo(1 - t / Math.sqrt(2 + t * t), 12);
    expect([r.low, r.high]).toEqual([expect.closeTo(Math.exp(0.22 - 4.302653 * se), 5), expect.closeTo(Math.exp(0.22 + 4.302653 * se), 5)]);
  });

  it('coxRatioT: a point at the ratio with no spread, p 1 on 1 and 0 off it', () => {
    const flat = coxRatioT([{ t: 2.2, c: 2 }, { t: 1.1, c: 1 }, { t: 2.2, c: 2 }]);
    expect([flat.estimate, flat.low, flat.high, flat.p]).toEqual([expect.closeTo(1.1, 12), expect.closeTo(1.1, 12), expect.closeTo(1.1, 12), 0]);
    expect(coxRatioT([{ t: 3, c: 3 }, { t: 5, c: 5 }]).p).toBe(1);
  });

  it('coxRatioT: a sum that is not positive gives the not-a-number result', () => {
    for (const r of [coxRatioT([...repos, { t: 0, c: 1 }]), coxRatioT([...repos, { t: 1, c: 0 }]), coxRatioT([...repos, { t: -1, c: 2 }])]) {
      expect([r.estimate, r.low, r.high, r.p].every(Number.isNaN)).toBe(true);
    }
  });
});
