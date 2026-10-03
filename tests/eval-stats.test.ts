import { describe, it, expect } from 'vitest';
import {
  addUsage,
  priceUsage,
  uncachedEquivalentInput,
  seededRandom,
  pairedBootstrap,
  clusteredPairedBootstrap,
  costPerResolvedDelta,
  passAtK,
  passHatK,
  twoLevelBootstrap,
  holmAdjust,
  verdict,
  combineCodings,
  harmGate,
  type Estimate,
  type Repository,
  type VerdictResult,
  type VerdictSpec,
} from '../src/eval-stats.js';

describe('four-bucket cost accounting', () => {
  const usage = { inputTokens: 1_000_000, cacheWriteTokens: 2_000_000, cacheReadTokens: 10_000_000, outputTokens: 500_000 };

  it('prices each bucket at its own rate', () => {
    const prices = { inputPerMTok: 3, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3, outputPerMTok: 15 };
    expect(priceUsage(usage, prices)).toBeCloseTo(3 + 7.5 + 3 + 7.5, 10);
  });

  it('converts input to uncached-equivalent tokens with cache ratios', () => {
    expect(uncachedEquivalentInput(usage)).toBeCloseTo(1_000_000 + 2_500_000 + 1_000_000, 6);
    expect(uncachedEquivalentInput(usage, { write: 1, read: 0.5 })).toBe(8_000_000);
  });

  it('adds usages bucket by bucket', () => {
    expect(addUsage(usage, usage).cacheReadTokens).toBe(20_000_000);
    expect(addUsage()).toEqual({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
  });

  it('shows why raw tokens overstate savings when input is mostly cache reads', () => {
    // Cutting 10% of the cached history saves far less than 10% of the input bill.
    const before = { inputTokens: 5_000, cacheWriteTokens: 5_000, cacheReadTokens: 900_000, outputTokens: 0 };
    const after = { ...before, cacheReadTokens: 810_000 };
    const rawCut = 1 - (after.inputTokens + after.cacheWriteTokens + after.cacheReadTokens)
      / (before.inputTokens + before.cacheWriteTokens + before.cacheReadTokens);
    const billCut = 1 - uncachedEquivalentInput(after) / uncachedEquivalentInput(before);
    expect(rawCut).toBeGreaterThan(0.09);
    expect(billCut).toBeGreaterThan(rawCut * 0.8);
    expect(billCut).toBeLessThan(0.1);
  });
});

describe('bootstrap', () => {
  it('is deterministic for a seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const diffs = [0.1, -0.2, 0.3, 0.05, 0.2, -0.1, 0.15];
    expect(pairedBootstrap(diffs, { seed: 7 })).toEqual(pairedBootstrap(diffs, { seed: 7 }));
  });

  it('brackets a clear effect away from zero and a null effect around zero', () => {
    const rand = seededRandom(3);
    const clear = Array.from({ length: 200 }, () => 1 + (rand() - 0.5));
    const est = pairedBootstrap(clear);
    expect(est.estimate).toBeCloseTo(1, 1);
    expect(est.low).toBeGreaterThan(0);
    const noise = Array.from({ length: 200 }, () => rand() - 0.5);
    const nul = pairedBootstrap(noise);
    expect(nul.low).toBeLessThan(0);
    expect(nul.high).toBeGreaterThan(0);
  });

  it('gives a wider interval when clustering is respected', () => {
    // Five repos, each with a shared offset: tasks inside a repo move together.
    const byCluster = new Map<string, number[]>();
    const offsets = [-1, -0.5, 0, 0.5, 1.2];
    offsets.forEach((o, i) => byCluster.set(`repo${i}`, Array.from({ length: 30 }, (_, j) => o + (j % 3) * 0.01)));
    const clustered = clusteredPairedBootstrap(byCluster);
    const naive = pairedBootstrap([...byCluster.values()].flat());
    expect(clustered.estimate).toBeCloseTo(naive.estimate, 10);
    expect(clustered.high - clustered.low).toBeGreaterThan(3 * (naive.high - naive.low));
  });

  it('handles empty input', () => {
    expect(pairedBootstrap([])).toEqual({ estimate: 0, low: 0, high: 0, iterations: 0 });
    expect(clusteredPairedBootstrap(new Map()).iterations).toBe(0);
  });
});

describe('cost per resolved task', () => {
  it('computes the paired delta and its interval', () => {
    const control = Array.from({ length: 60 }, (_, i) => ({ cost: 1, resolved: i % 2 === 0 }));
    const treatment = Array.from({ length: 60 }, (_, i) => ({ cost: 0.8, resolved: i % 2 === 0 }));
    const r = costPerResolvedDelta(control, treatment);
    expect(r.control).toBeCloseTo(2, 10);
    expect(r.treatment).toBeCloseTo(1.6, 10);
    expect(r.relative.estimate).toBeCloseTo(-0.2, 10);
    expect(r.relative.high).toBeLessThan(0);
  });

  it('refuses unpaired arms and reports an arm that resolves nothing', () => {
    expect(() => costPerResolvedDelta([{ cost: 1, resolved: true }], [])).toThrow(/same tasks/);
    const r = costPerResolvedDelta([{ cost: 1, resolved: false }], [{ cost: 1, resolved: true }]);
    expect(r.control).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(r.delta.estimate)).toBe(true);
  });
});

describe('pass@k and pass^k', () => {
  const runs = [[true, false, true], [false, false, false], [true, true, true], [false, true]];
  it('pass@k counts any success in the first k runs', () => {
    expect(passAtK(runs, 1)).toBeCloseTo(2 / 4, 10);
    expect(passAtK(runs, 3)).toBeCloseTo(2 / 3, 10);
  });
  it('is not a number when no task has k runs', () => {
    expect(Number.isNaN(passAtK([[true]], 3))).toBe(true);
    expect(Number.isNaN(passHatK([], 1))).toBe(true);
  });
  it('pass^k counts all-success in the first k runs', () => {
    expect(passHatK(runs, 2)).toBeCloseTo(1 / 4, 10);
    expect(passHatK(runs, 3)).toBeCloseTo(1 / 3, 10);
  });
});

describe('two-level bootstrap', () => {
  const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
  const data: Repository<number>[] = [[[1, 2], [3]], [[0.5], [2, 2]], [[-1], [4, 1]]];
  const small = { iterations: 300 };

  it('is deterministic for a seed and moves with the seed', () => {
    const a = twoLevelBootstrap(data, mean, { ...small, seed: 7 });
    expect(a).toEqual(twoLevelBootstrap(data, mean, { ...small, seed: 7 }));
    const b = twoLevelBootstrap(data, mean, { ...small, seed: 8 });
    expect([a.low, a.high]).not.toEqual([b.low, b.high]);
  });

  it('reports the estimate with no p for one repository, and NaN for empty input', () => {
    const one = twoLevelBootstrap([[[1, 2], [3]]], mean, small);
    expect(one.estimate).toBe(2);
    expect(Number.isNaN(one.p)).toBe(true);
    expect(Number.isFinite(one.low) && Number.isFinite(one.high)).toBe(true);
    expect(one.iterations).toBe(300);
    const empties: Repository<number>[][] = [[], [[]], [[[]]]];
    for (const empty of empties) {
      const r = twoLevelBootstrap(empty, mean, small);
      expect([r.estimate, r.low, r.high, r.p].every(Number.isNaN)).toBe(true);
      expect([r.iterations, r.dropped]).toEqual([0, 0]);
    }
  });

  it('ignores empty families and repositories', () => {
    const padded: Repository<number>[] = [[[1, 2], [], [3]], [], [[0.5], [2, 2]], [[-1], [4, 1]]];
    expect(twoLevelBootstrap(padded, mean, small)).toEqual(twoLevelBootstrap(data, mean, small));
  });

  it('is wider than the family-level bootstrap when repositories carry the variation', () => {
    const offsets = [-1, 0, 1];
    const repos: Repository<number>[] = offsets.map((o) =>
      Array.from({ length: 5 }, (_, f) => [o + f * 0.01, o + f * 0.01 + 0.02, o - f * 0.01]));
    const byFamily = new Map<string, number[]>();
    repos.forEach((r, i) => r.forEach((fam, f) => byFamily.set(`${i}-${f}`, [...fam])));
    const two = twoLevelBootstrap(repos, mean, { iterations: 2000 });
    const one = clusteredPairedBootstrap(byFamily, { iterations: 2000 });
    expect(two.estimate).toBeCloseTo(one.estimate, 10);
    expect(two.high - two.low).toBeGreaterThan(2 * (one.high - one.low));
  });

  it('gives p = 0 when every unit is above the null, using the 10,000 default', () => {
    const r = twoLevelBootstrap([[[1], [2]], [[3], [1]]], mean);
    expect(r.p).toBe(0);
    expect(r.iterations).toBe(10_000);
    expect(r.dropped).toBe(0);
    expect(r.low).toBeGreaterThan(0);
  });

  it('gives p above 0.5 for a distribution centred on the null', () => {
    const centred: Repository<number>[] = [[[1], [-1]], [[2], [-2]], [[0.5], [-0.5]]];
    expect(twoLevelBootstrap(centred, mean, small).p).toBeGreaterThan(0.5);
  });

  it('tests ratios against nullValue 1, and counts exact ties on both sides', () => {
    type Pair = { c: number; t: number };
    const ratio = (u: readonly Pair[]): number => mean(u.map((x) => x.t)) / mean(u.map((x) => x.c));
    const flat: Repository<Pair>[] = [[[{ c: 1, t: 1 }]], [[{ c: 1, t: 1 }]], [[{ c: 1, t: 1 }]]];
    expect(twoLevelBootstrap(flat, ratio, { ...small, nullValue: 1 }).p).toBe(1);
    expect(twoLevelBootstrap(flat, ratio, small).p).toBe(0);
    const saving: Repository<Pair>[] = [[[{ c: 1, t: 0.5 }]], [[{ c: 1, t: 0.6 }]], [[{ c: 1, t: 0.4 }]]];
    const r = twoLevelBootstrap(saving, ratio, { ...small, nullValue: 1 });
    expect(r.p).toBe(0);
    expect(r.high).toBeLessThan(1);
  });

  it('drops non-finite resamples and counts them', () => {
    type Pair = { c: number; t: number };
    const ratio = (u: readonly Pair[]): number => mean(u.map((x) => x.t)) / mean(u.map((x) => x.c));
    const repos: Repository<Pair>[] = [[[{ c: 0, t: 0 }]], [[{ c: 1, t: 1 }]]];
    const r = twoLevelBootstrap(repos, ratio, { iterations: 500, nullValue: 1 });
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.iterations + r.dropped).toBe(500);
    const none = twoLevelBootstrap(data, () => Number.NaN, small);
    expect([none.estimate, none.low, none.high, none.p].every(Number.isNaN)).toBe(true);
    expect([none.iterations, none.dropped]).toEqual([0, 300]);
  });

  it('keeps the seeds of a family together', () => {
    const repos: Repository<number>[] = [[[100, -100], [5]], [[7], [9]]];
    let broken = 0;
    let sawFamily = 0;
    twoLevelBootstrap(repos, (units) => {
      const up = units.filter((u) => u === 100).length;
      const down = units.filter((u) => u === -100).length;
      if (up !== down) broken++;
      if (up > 0) sawFamily++;
      return mean(units);
    }, small);
    expect(broken).toBe(0);
    expect(sawFamily).toBeGreaterThan(0);
  });

  it('draws repositories first, then every family of each drawn repository', () => {
    // One family of one unit in A, three in B: two draws give (2,0) from AA, (1,3) from AB or BA, (0,6) from BB.
    const repos: Repository<string>[] = [[['A']], [['B'], ['B'], ['B']]];
    const seen = new Set<string>();
    twoLevelBootstrap(repos, (units) => {
      seen.add(`${units.filter((u) => u === 'A').length},${units.filter((u) => u === 'B').length}`);
      return 0;
    }, { iterations: 500 });
    // The point-estimate call sees every unit: (1,3), already an allowed pair.
    expect([...seen].sort()).toEqual(['0,6', '1,3', '2,0']);
  });

  describe('p-value from a scripted statistic', () => {
    const repos: Repository<number>[] = [[[1]], [[2]]];
    // The estimate call comes after the resamples, so it never shifts the sequence the p-value sees.
    const run = (seq: readonly number[], iterations: number, nullValue = 0) => {
      let call = 0;
      return twoLevelBootstrap(repos, () => seq[call++ % seq.length]!, { iterations, nullValue });
    };

    it('is 0.5 when a quarter of the samples sit below the null', () => {
      expect(run([-1, 1, 1, 1], 400).p).toBeCloseTo(0.5, 12);
    });

    it('counts a sample on the null on both sides', () => {
      // below = 2 of 8 with the tie, only 1 of 8 without it.
      expect(run([-1, 0, 1, 1, 1, 1, 1, 1], 400).p).toBeCloseTo(0.5, 12);
      expect(run([1, 0, -1, -1, -1, -1, -1, -1], 400).p).toBeCloseTo(0.5, 12);
    });

    it('divides by the kept samples only', () => {
      // Per cycle of 8: 6 kept (one below, five above), so p = 2 x 1/6, not 2 x 1/8.
      const r = run([-1, Number.NaN, 1, 1, 1, Number.NaN, 1, 1], 400);
      expect(r.dropped).toBe(100);
      expect(r.p).toBeCloseTo(1 / 3, 12);
    });
  });

  it('rejects iterations that are not a positive integer', () => {
    for (const iterations of [0, -5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => twoLevelBootstrap(data, mean, { iterations })).toThrow(RangeError);
    }
    expect(() => twoLevelBootstrap([], mean, { iterations: 0 })).toThrow(RangeError);
  });

  it('draws the same resamples for two statistics under one seed', () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    twoLevelBootstrap(data, (u) => { seenA.push(u.join(',')); return mean(u); }, { ...small, seed: 3 });
    twoLevelBootstrap(data, (u) => { seenB.push(u.join(',')); return u.length; }, { ...small, seed: 3 });
    expect(seenA).toHaveLength(301);
    expect(seenB).toEqual(seenA);
  });
});

describe('holmAdjust', () => {
  const expectClose = (got: number[], want: number[]): void => {
    expect(got).toHaveLength(want.length);
    want.forEach((w, i) => (Number.isNaN(w) ? expect(got[i]).toBeNaN() : expect(got[i]).toBeCloseTo(w, 12)));
  };

  it('matches the Holm step-down by hand', () => {
    expectClose(holmAdjust([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
  });

  it('keeps NaN in place, ranks it last and keeps the family size', () => {
    expectClose(holmAdjust([0.01, Number.NaN, 0.03]), [0.03, Number.NaN, 0.06]);
  });

  it('caps at 1 and handles an empty list', () => {
    expectClose(holmAdjust([0.6, 0.9, 0.2]), [1, 1, 0.6]);
    expect(holmAdjust([])).toEqual([]);
  });

  it('rejects a p outside 0 to 1, including infinities', () => {
    expect(() => holmAdjust([0.01, 1.5])).toThrow();
    expect(() => holmAdjust([-0.1])).toThrow();
    expect(() => holmAdjust([Number.POSITIVE_INFINITY])).toThrow();
  });
});

describe('verdict', () => {
  const est = (estimate: number, low: number, high: number): Estimate => ({ estimate, low, high, iterations: 10_000 });
  const lowerSpec: VerdictSpec = { helpful: 'lower', tieBand: [-0.15, 0.15], minimumEffectAt: -0.15 };
  const higherSpec: VerdictSpec = { helpful: 'higher', tieBand: [-0.05, 0.05], minimumEffectAt: 0.1 };
  const ratioSpec: VerdictSpec = { helpful: 'lower', nullValue: 1, tieBand: [0.95, 1 / 0.95], minimumEffectAt: 0.95 };

  it('calls a loss, and never reports a minimum for it', () => {
    expect(verdict(est(0.2, 0.1, 0.3), 0.01, lowerSpec)).toEqual({ verdict: 'loss', reachesMinimum: false });
    expect(verdict(est(-0.2, -0.3, -0.1), 0.01, higherSpec)).toEqual({ verdict: 'loss', reachesMinimum: false });
  });

  it('calls a win and checks the minimum inclusively', () => {
    expect(verdict(est(-0.2, -0.3, -0.1), 0.01, lowerSpec)).toEqual({ verdict: 'win', reachesMinimum: true });
    expect(verdict(est(-0.15, -0.3, -0.01), 0.01, lowerSpec)).toEqual({ verdict: 'win', reachesMinimum: true });
    expect(verdict(est(-0.14, -0.3, -0.01), 0.01, lowerSpec)).toEqual({ verdict: 'win', reachesMinimum: false });
    expect(verdict(est(0.2, 0.1, 0.3), 0.01, higherSpec)).toEqual({ verdict: 'win', reachesMinimum: true });
    expect(verdict(est(0.1, 0.02, 0.2), 0.01, higherSpec)).toEqual({ verdict: 'win', reachesMinimum: true });
    expect(verdict(est(0.07, 0.02, 0.12), 0.01, higherSpec)).toEqual({ verdict: 'win', reachesMinimum: false });
  });

  it('reads ratios against nullValue 1', () => {
    expect(verdict(est(0.9, 0.85, 0.94), 0.01, ratioSpec)).toEqual({ verdict: 'win', reachesMinimum: true });
    expect(verdict(est(0.95, 0.9, 0.99), 0.01, ratioSpec)).toEqual({ verdict: 'win', reachesMinimum: true });
    expect(verdict(est(0.97, 0.96, 0.99), 0.01, ratioSpec)).toEqual({ verdict: 'win', reachesMinimum: false });
    expect(verdict(est(1.2, 1.1, 1.3), 0.01, ratioSpec)).toEqual({ verdict: 'loss', reachesMinimum: false });
    expect(verdict(est(1, 0.97, 1.03), 0.5, ratioSpec)).toEqual({ verdict: 'tie', reachesMinimum: false });
  });

  it('calls a tie when the interval sits inside the band, edges included', () => {
    expect(verdict(est(0.02, -0.1, 0.1), 0.5, lowerSpec)).toEqual({ verdict: 'tie', reachesMinimum: false });
    expect(verdict(est(0, -0.15, 0.15), 0.5, lowerSpec).verdict).toBe('tie');
  });

  it('calls everything else inconclusive', () => {
    expect(verdict(est(0, -0.3, 0.3), 0.5, lowerSpec)).toEqual({ verdict: 'inconclusive', reachesMinimum: false });
    expect(verdict(est(0, -0.3, 0.3), 0.01, lowerSpec).verdict).toBe('inconclusive');
  });

  it('lets a significant p beat the tie band, and an inflated p fall back to tie', () => {
    expect(verdict(est(-0.05, -0.1, -0.01), 0.01, lowerSpec)).toEqual({ verdict: 'win', reachesMinimum: false });
    expect(verdict(est(0.05, 0.01, 0.1), 0.01, lowerSpec).verdict).toBe('loss');
    expect(verdict(est(-0.05, -0.1, -0.01), 0.06, lowerSpec).verdict).toBe('tie');
    expect(verdict(est(-0.05, -0.1, -0.01), 0.05, lowerSpec).verdict).toBe('tie');
  });

  it('honours a custom alpha', () => {
    expect(verdict(est(-0.2, -0.3, -0.1), 0.04, { ...lowerSpec, alpha: 0.01 }).verdict).toBe('inconclusive');
  });

  it('never calls a win or loss for an estimate on the null', () => {
    expect(verdict(est(0, -0.1, 0.1), 0.01, lowerSpec).verdict).toBe('tie');
    expect(verdict(est(0, -0.3, 0.3), 0.01, lowerSpec).verdict).toBe('inconclusive');
  });

  it('is inconclusive on a NaN p or a NaN bound', () => {
    expect(verdict(est(-0.05, -0.1, -0.01), Number.NaN, lowerSpec).verdict).toBe('inconclusive');
    expect(verdict(est(0, -0.1, 0.1), Number.NaN, lowerSpec).verdict).toBe('inconclusive');
    expect(verdict(est(-0.2, Number.NaN, -0.1), 0.01, lowerSpec).verdict).toBe('inconclusive');
    expect(verdict(est(-0.2, -0.3, Number.NaN), 0.01, lowerSpec).verdict).toBe('inconclusive');
  });
});

describe('combineCodings', () => {
  const r = (v: VerdictResult['verdict'], reachesMinimum = false): VerdictResult => ({ verdict: v, reachesMinimum });

  it('needs a win under both codings', () => {
    expect(combineCodings(r('win', true), r('win', true))).toEqual(r('win', true));
    expect(combineCodings(r('win', true), r('tie'))).toEqual(r('inconclusive'));
    expect(combineCodings(r('win', true), r('inconclusive'))).toEqual(r('inconclusive'));
  });

  it('reports a loss under either coding', () => {
    expect(combineCodings(r('loss'), r('win', true))).toEqual(r('loss'));
    expect(combineCodings(r('inconclusive'), r('loss'))).toEqual(r('loss'));
    expect(combineCodings(r('loss'), r('tie'))).toEqual(r('loss'));
  });

  it('is inconclusive when one coding is inconclusive and the other a tie', () => {
    expect(combineCodings(r('inconclusive'), r('tie'))).toEqual(r('inconclusive'));
    expect(combineCodings(r('tie'), r('inconclusive'))).toEqual(r('inconclusive'));
  });

  it('keeps a tie only when both are ties', () => {
    expect(combineCodings(r('tie'), r('tie'))).toEqual(r('tie'));
  });

  it('reaches the minimum only when both codings do', () => {
    expect(combineCodings(r('win', true), r('win', false))).toEqual(r('win', false));
  });
});

describe('harmGate', () => {
  const upper = (high: number): Estimate => ({ estimate: 1, low: 0.9, high, iterations: 10_000 });
  const lower = (low: number): Estimate => ({ estimate: 0, low, high: 0.05, iterations: 10_000 });

  it('needs the cost bound strictly below 1.10', () => {
    expect(harmGate(upper(1.0999), lower(0)).costOk).toBe(true);
    expect(harmGate(upper(1.1), lower(0)).costOk).toBe(false);
    expect(harmGate(upper(1.1001), lower(0)).costOk).toBe(false);
  });

  it('needs the resolve bound strictly above -0.05', () => {
    expect(harmGate(upper(1), lower(-0.0499)).resolveOk).toBe(true);
    expect(harmGate(upper(1), lower(-0.05)).resolveOk).toBe(false);
    expect(harmGate(upper(1), lower(-0.0501)).resolveOk).toBe(false);
  });

  it('passes only when both checks pass, and fails a NaN bound', () => {
    expect(harmGate(upper(1.05), lower(0.01))).toEqual({ pass: true, costOk: true, resolveOk: true });
    expect(harmGate(upper(1.2), lower(0.01))).toEqual({ pass: false, costOk: false, resolveOk: true });
    expect(harmGate(upper(Number.NaN), lower(0.01)).pass).toBe(false);
    expect(harmGate(upper(1), lower(Number.NaN))).toEqual({ pass: false, costOk: true, resolveOk: false });
  });
});
