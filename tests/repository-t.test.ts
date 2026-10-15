/** Student t tests for Z0: table quantiles, closed-form CDFs, the zero-spread rule, one repository (Amendment 1), and the
 * fixed-repository family tests and their pooled mean squares (Amendment 2) against a textbook two-way ANOVA. */
import { describe, it, expect } from 'vitest';
import {
  fixedRepositoryRatioT,
  fixedRepositoryT,
  incompleteBeta,
  pooledComponents,
  repositoryT,
  studentTCdf,
  studentTQuantile,
  type FamilyUnit,
  type RatioCell,
} from '../src/eval/repository-t.js';

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
    for (const r of [repositoryT([0.4]), repositoryT([])]) {
      expect([r.estimate, r.low, r.high, r.p].every(Number.isNaN)).toBe(true);
    }
  });
});

type Grid = readonly (readonly number[])[];
const avg = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
// A grid is indexed [family][seed]; seeds are numbered from 1.
const unitsOf = (repo: string, grid: Grid): FamilyUnit[] =>
  grid.flatMap((row, i) => row.map((value, j) => ({ repo, family: `f${i}`, seed: j + 1, value })));
const isNaNResult = (r: { estimate: number; low: number; high: number; p: number }): boolean =>
  [r.estimate, r.low, r.high, r.p].every(Number.isNaN);
const rounded = (df: number): number => Math.round(df * 1000) / 1000;

/** The textbook two-way ANOVA mean squares of a complete family-by-seed grid, by plain loops. */
function anova(grid: Grid) {
  const [k, s] = [grid.length, grid[0]!.length];
  const grand = avg(grid.flat());
  const row = grid.map(avg);
  const col = Array.from({ length: s }, (_, j) => avg(grid.map((r) => r[j]!)));
  let [ssF, ssQ, ssE] = [0, 0, 0];
  for (let i = 0; i < k; i++) ssF += s * (row[i]! - grand) ** 2;
  for (let j = 0; j < s; j++) ssQ += k * (col[j]! - grand) ** 2;
  for (let i = 0; i < k; i++) for (let j = 0; j < s; j++) ssE += (grid[i]![j]! - row[i]! - col[j]! + grand) ** 2;
  return { k, s, grand, F: ssF / (k - 1), Q: ssQ / (s - 1), E: ssE / ((k - 1) * (s - 1)) };
}

// Strong seed effects, tiny residual: Q is far above E.
const GRID_A: Grid = [[1.1, 1.5, 0.5], [2.1, 2.9, 1.8], [0.5, 1.2, -0.1]];
const GRID_B: Grid = [[3.2, 3.9, 2.9], [4.3, 4.6, 3.7], [2.6, 3.2, 2.0]];
// Strong family effects, noisy cells: Q is below E.
const GRID_C: Grid = [[1.0, 1.9, 0.6], [3.1, 2.2, 3.4], [5.2, 4.5, 5.6]];
const GRID_D: Grid = [[2.0, 1.4, 2.3], [4.1, 4.8, 3.5], [6.3, 5.9, 6.8]];

describe('fixedRepositoryT', () => {
  it('complete tables: the mean squares are the textbook ANOVA, and the variance is (F + Q - E) / (G k s) when Q > E', () => {
    const [a, b] = [anova(GRID_A), anova(GRID_B)];
    const [F, Q, E] = [avg([a.F, b.F]), avg([a.Q, b.Q]), avg([a.E, b.E])];
    expect(Q).toBeGreaterThan(E);
    const [g, k, s] = [2, 3, 3];
    const r = fixedRepositoryT([...unitsOf('A', GRID_A), ...unitsOf('B', GRID_B)]);
    const v = (F + Q - E) / (g * k * s);
    // Satterthwaite over the F, Q and -E terms, with the pooled df G(k-1), G(s-1) and G(k-1)(s-1).
    const parts: readonly (readonly [number, number])[] = [[F / (g * k * s), g * (k - 1)], [Q / (g * k * s), g * (s - 1)], [-E / (g * k * s), g * (k - 1) * (s - 1)]];
    const df = v ** 2 / parts.reduce((sum, [x, d]) => sum + x ** 2 / d, 0);
    expect(r.estimate).toBeCloseTo(avg([a.grand, b.grand]), 12);
    expect(r.se! ** 2).toBeCloseTo(v, 12);
    expect(r.df).toBeCloseTo(df, 9);
    expect([r.nullValue, r.iterations, r.dropped]).toEqual([0, 0, 0]);
    const q = studentTQuantile(0.975, rounded(df));
    expect([r.low, r.high]).toEqual([expect.closeTo(r.estimate - q * r.se!, 9), expect.closeTo(r.estimate + q * r.se!, 9)]);
    expect(r.p).toBeCloseTo(2 * (1 - studentTCdf(r.estimate / r.se!, df)), 9);
  });

  it('complete tables with Q <= E: the variance is F / (G k s) on the family df', () => {
    const [c, d] = [anova(GRID_C), anova(GRID_D)];
    expect(Math.max(c.Q, d.Q)).toBeLessThanOrEqual(Math.min(c.E, d.E));
    const r = fixedRepositoryT([...unitsOf('C', GRID_C), ...unitsOf('D', GRID_D)]);
    expect(r.estimate).toBeCloseTo(avg([c.grand, d.grand]), 12);
    expect(r.se! ** 2).toBeCloseTo(avg([c.F, d.F]) / (2 * 3 * 3), 12);
    expect(r.df).toBeCloseTo(4, 9);
  });

  it('a cell holding several units is their mean, and unit order does not matter', () => {
    const doubled = unitsOf('A', GRID_A).flatMap((u) => [{ ...u, value: u.value - 0.2 }, { ...u, value: u.value + 0.2 }]);
    const base = fixedRepositoryT([...unitsOf('A', GRID_A), ...unitsOf('B', GRID_B)]);
    const split = fixedRepositoryT([...unitsOf('B', GRID_B).reverse(), ...doubled]);
    expect(split.estimate).toBeCloseTo(base.estimate, 12);
    expect([split.se, split.df]).toEqual([expect.closeTo(base.se!, 12), expect.closeTo(base.df!, 9)]);
  });

  it('one missing cell: the fit converges on the least-squares mean, which is the grand mean of the Yates-filled table', () => {
    const present = unitsOf('A', GRID_A).filter((u) => !(u.family === 'f2' && u.seed === 3));
    const [k, s] = [3, 3];
    const total = present.reduce((sum, u) => sum + u.value, 0);
    const fill = (k * (GRID_A[2]![0]! + GRID_A[2]![1]!) + s * (GRID_A[0]![2]! + GRID_A[1]![2]!) - total) / ((k - 1) * (s - 1));
    const filled: Grid = [GRID_A[0]!, GRID_A[1]!, [GRID_A[2]![0]!, GRID_A[2]![1]!, fill]];
    const r = fixedRepositoryT([...present, ...unitsOf('B', GRID_B)]);
    expect(r.estimate).toBeCloseTo(avg([anova(filled).grand, anova(GRID_B).grand]), 10);
    expect(r.se).toBeGreaterThan(0);
    expect(r.df).toBeGreaterThan(0);
    expect(Number.isFinite(r.p)).toBe(true);
  });

  it('a repository is fitted from one residual df on: n - k - s + 1 = 1 fits, 0 falls back to the mean of its cells', () => {
    const thin: Grid = [[1.0, 1.6, 0.9], [2.2, 2.1, 2.9]];
    const keep = (miss: readonly (readonly [string, number])[]): FamilyUnit[] =>
      unitsOf('T', thin).filter((u) => !miss.some(([f, sd]) => u.family === f && u.seed === sd));
    const other = unitsOf('B', GRID_B);
    // One cell out (n 5, dfE 1): the Yates-filled grand mean; two out (n 4, dfE 0): the plain mean of the cells.
    const one = keep([['f1', 3]]);
    const present = one.reduce((sum, u) => sum + u.value, 0);
    const fill = (2 * (2.2 + 2.1) + 3 * 0.9 - present) / 2;
    expect(fixedRepositoryT([...one, ...other]).estimate).toBeCloseTo(avg([(present + fill) / 6, anova(GRID_B).grand]), 10);
    const two = keep([['f1', 3], ['f0', 1]]);
    const plain = avg(two.map((u) => u.value));
    expect(fixedRepositoryT([...two, ...other]).estimate).toBeCloseTo(avg([plain, anova(GRID_B).grand]), 12);
  });

  it('a repository with one seed next to a fitted one adds its mean and takes the pooled spread', () => {
    const a = anova(GRID_A);
    const single = GRID_B.map((row) => [row[0]!]);
    const r = fixedRepositoryT([...unitsOf('A', GRID_A), ...unitsOf('B', single)]);
    expect(r.estimate).toBeCloseTo(avg([a.grand, avg(single.flat())]), 12);
    // Repository A (k 3, s 3, n 9) and B (k 3, s 1, n 3) against sBar 3, kBar 3: cF 2/9, cQ 1/9 + 1/3, cE -1/9 - 1/9.
    const [cF, cQ, cE] = [2 / 9, 1 / 9 + 1 / 3, -2 / 9];
    const parts: readonly (readonly [number, number])[] = [[(cF * a.F) / 4, 2], [(cQ * a.Q) / 4, 2], [(cE * a.E) / 4, 4]];
    const v = parts.reduce((sum, [x]) => sum + x, 0);
    expect(r.se! ** 2).toBeCloseTo(v, 12);
    expect(r.df).toBeCloseTo(v ** 2 / parts.reduce((sum, [x, d]) => sum + x ** 2 / d, 0), 9);
    // A leak that leaves a repository one seed deep must not void the test.
    expect(Number.isFinite(r.p)).toBe(true);
  });

  it('a table that splits into two family-seed blocks is unfitted: it adds its mean and takes the pooled spread', () => {
    // 2 families x 2 seeds twice over, sharing no family and no seed: n 8, k 4, s 4, so n - k - s + 1 = 1 would pass as a fit.
    const block = (families: readonly string[], seeds: readonly number[]): FamilyUnit[] =>
      families.flatMap((family, i) => seeds.map((seed, j) => ({ repo: 'X', family, seed, value: 1 + 0.9 * i + 0.5 * j + ((i * j) % 2) * 0.3 })));
    const split = [...block(['f0', 'f1'], [1, 2]), ...block(['f2', 'f3'], [3, 4])];
    const plain = avg(split.map((u) => u.value));
    const other = unitsOf('B', GRID_B);
    const r = fixedRepositoryT([...split, ...other]);
    expect(r.estimate).toBeCloseTo(avg([plain, anova(GRID_B).grand]), 12);
    expect(Number.isFinite(r.p)).toBe(true);
    const pooled = pooledComponents([...split, ...other])!;
    expect([pooled.dfF, pooled.dfQ, pooled.dfE]).toEqual([2, 2, 4]);
    expect(pooled.repos).toEqual([{ k: 4, s: 4, n: 8 }, { k: 3, s: 3, n: 9 }]);
  });

  it('gives the not-a-number result for one repository, or when no repository can be fitted', () => {
    expect(isNaNResult(fixedRepositoryT(unitsOf('A', GRID_A)))).toBe(true);
    expect(isNaNResult(fixedRepositoryT([]))).toBe(true);
    const oneSeed = (repo: string, grid: Grid) => unitsOf(repo, grid.map((row) => [row[0]!]));
    expect(isNaNResult(fixedRepositoryT([...oneSeed('A', GRID_A), ...oneSeed('B', GRID_B)]))).toBe(true);
    const holed = (repo: string, grid: Grid) => unitsOf(repo, grid.map((row) => row.slice(0, 2))).slice(0, 3);
    expect(isNaNResult(fixedRepositoryT([...holed('A', GRID_A), ...holed('B', GRID_B)]))).toBe(true);
    const nan = fixedRepositoryT([...unitsOf('A', GRID_A), ...unitsOf('B', GRID_B)].map((u, i) => (i === 4 ? { ...u, value: Number.NaN } : u)), 1);
    expect([isNaNResult(nan), nan.nullValue]).toEqual([true, 1]);
  });

  it('takes the critical value at df rounded to three decimals, so df 6.7368 and 6.7365 read one quantile', () => {
    const bumped = (by: number) => GRID_A.map((row, i) => (i === 0 ? [row[0]! + by, ...row.slice(1)] : row));
    const [x, y] = [0.001, 0.005].map((by) => fixedRepositoryT([...unitsOf('A', bumped(by)), ...unitsOf('B', GRID_B)]));
    expect(Math.abs(x!.df! - y!.df!)).toBeGreaterThan(2e-4);
    expect(rounded(x!.df!)).toBe(rounded(y!.df!));
    const q = studentTQuantile(0.975, rounded(x!.df!));
    for (const e of [x!, y!]) expect((e.high - e.estimate) / e.se!).toBeCloseTo(q, 10);
  });
});

describe('pooledComponents', () => {
  it('is null when no repository can be fitted', () => {
    const oneSeed = unitsOf('A', GRID_A.map((row) => [row[0]!]));
    expect(pooledComponents([])).toBeNull();
    expect(pooledComponents(oneSeed)).toBeNull();
  });

  it('takes one repository: its mean squares are the textbook ANOVA and sBar, kBar are n / k and n / s', () => {
    const a = anova(GRID_A);
    expect(pooledComponents(unitsOf('A', GRID_A))).toEqual({
      repos: [{ k: 3, s: 3, n: 9 }], F: expect.closeTo(a.F, 12), Q: expect.closeTo(a.Q, 12), E: expect.closeTo(a.E, 12),
      dfF: 2, dfQ: 2, dfE: 4, sBar: 3, kBar: 3,
    });
  });

  it('pools two repositories by df and lists a thin one among the repos without fitting it', () => {
    const [a, b] = [anova(GRID_A), anova(GRID_B)];
    const thin = unitsOf('T', GRID_C.map((row) => [row[0]!]));
    const p = pooledComponents([...unitsOf('A', GRID_A), ...unitsOf('B', GRID_B), ...thin])!;
    expect([p.F, p.Q, p.E]).toEqual([expect.closeTo(avg([a.F, b.F]), 12), expect.closeTo(avg([a.Q, b.Q]), 12), expect.closeTo(avg([a.E, b.E]), 12)]);
    expect([p.dfF, p.dfQ, p.dfE]).toEqual([4, 4, 8]);
    expect(p.repos).toEqual([{ k: 3, s: 3, n: 9 }, { k: 3, s: 3, n: 9 }, { k: 3, s: 1, n: 3 }]);
  });

  it('an exactly additive table has no residual, and F and Q are the hand-computed mean squares', () => {
    // y = a_i + b_j with a = (0, 1, 3) and b = (0, 2, 5): F = 3 x 14/3 / 2 = 7, Q = 3 x 38/3 / 2 = 19.
    const [rows, cols] = [[0, 1, 3], [0, 2, 5]];
    const grid: Grid = rows.map((x) => cols.map((y) => x + y));
    const p = pooledComponents(unitsOf('A', grid))!;
    expect(Math.abs(p.E)).toBeLessThan(1e-12);
    expect(p.F).toBeCloseTo(7, 12);
    expect(p.Q).toBeCloseTo(19, 12);
  });
});

describe('fixedRepositoryRatioT', () => {
  const cells: readonly RatioCell[] = [
    { repo: 'a', family: 'f0', seed: 1, t: 3.0, c: 2.0 },
    { repo: 'a', family: 'f0', seed: 2, t: 3.4, c: 2.1 },
    { repo: 'a', family: 'f1', seed: 1, t: 5.1, c: 3.9 },
    { repo: 'a', family: 'f1', seed: 2, t: 4.6, c: 4.0 },
    { repo: 'b', family: 'f0', seed: 1, t: 2.2, c: 2.0 },
    { repo: 'b', family: 'f0', seed: 2, t: 2.9, c: 2.2 },
    { repo: 'b', family: 'f1', seed: 1, t: 6.3, c: 4.8 },
    { repo: 'b', family: 'f1', seed: 2, t: 5.6, c: 4.1 },
  ];

  it('is sum(t) / sum(c), with the interval R exp(-+ q seLog) and seLog the residual spread over R', () => {
    const [totalT, totalC] = [avg(cells.map((x) => x.t)) * cells.length, avg(cells.map((x) => x.c)) * cells.length];
    const ratio = totalT / totalC;
    const cBar = totalC / cells.length;
    const spread = fixedRepositoryT(cells.map((x) => ({ repo: x.repo, family: x.family, seed: x.seed, value: (x.t - ratio * x.c) / cBar })), 0);
    const seLog = spread.se! / ratio;
    const q = studentTQuantile(0.975, rounded(spread.df!));
    const r = fixedRepositoryRatioT(cells);
    expect([r.estimate, r.nullValue, r.df]).toEqual([expect.closeTo(ratio, 12), 1, spread.df]);
    expect(r.se).toBeCloseTo(seLog, 12);
    expect([r.low, r.high]).toEqual([expect.closeTo(ratio * Math.exp(-q * seLog), 9), expect.closeTo(ratio * Math.exp(q * seLog), 9)]);
    expect(r.p).toBeCloseTo(2 * (1 - studentTCdf(Math.log(ratio) / seLog, spread.df!)), 9);
    expect(r.low).toBeLessThan(ratio);
    expect(r.high).toBeGreaterThan(ratio);
  });

  it('puts a ratio with no spread at the point, p 1 on 1 and 0 off it', () => {
    const flat = (k: number) => cells.map((x) => ({ ...x, t: k * x.c }));
    expect(fixedRepositoryRatioT(flat(1.1))).toMatchObject({ estimate: expect.closeTo(1.1, 12), low: expect.closeTo(1.1, 12), high: expect.closeTo(1.1, 12), p: 0 });
    expect(fixedRepositoryRatioT(flat(1)).p).toBe(1);
  });

  it('gives the not-a-number result for a sum that is not positive, or no fitted repository', () => {
    const zeroT = cells.map((x) => ({ ...x, t: 0 }));
    const negC = cells.map((x) => ({ ...x, c: -x.c }));
    const oneSeed = cells.filter((x) => x.seed === 1);
    for (const r of [fixedRepositoryRatioT(zeroT), fixedRepositoryRatioT(negC), fixedRepositoryRatioT(oneSeed), fixedRepositoryRatioT(cells.filter((x) => x.repo === 'a'))]) {
      expect(isNaNResult(r)).toBe(true);
      expect(r.nullValue).toBe(1);
    }
  });
});
