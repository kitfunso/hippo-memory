/** Z0 round 4 simulation engine (prereg item 10, :112): layouts, predicted error, exact and ratio draws, the 0/1 and resampled cases, levelCells and levelSearch. Hand-made calibrations and cells only. */
import { describe, it, expect, vi } from 'vitest';
import { seededRandom } from '../dist/eval/eval-stats.js';
import { fixedRepositoryT } from '../dist/eval/repository-t.js';
import { weightedVariance } from '../scripts/token-eval/z0-cost-solved.mjs';
import { CODINGS } from '../scripts/token-eval/z0-hypotheses.mjs';
import {
  binaryRun, cellSeed, levelCells, levelSearch, normal, predictedSe, repeatRun, resampledRun, ruleSeeds, seedsNeeded, spreadComponents, unclampedSpreads,
} from '../scripts/token-eval/z0-size-sim.mjs';
import { T_NULLS, scoreTest } from '../scripts/token-eval/z0-verdict-r4.mjs';

// Each case simulates thousands of runs; a shared CI runner can be several times slower than a laptop.
vi.setConfig({ testTimeout: 300_000 });

type Unit = { repo: string; family: string; seed: number; value: number };
type Part = { scale?: number; loss?: number; family: number; sequence: number; noise: number };
const one = (c: Part) => ({ violation: { scale: 1, loss: 0, ...c }, excluded: { scale: 1, loss: 0, ...c } });
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

const REPEAT_CAL = {
  violation: { scale: 0.8, loss: 0.05, family: 0.02, sequence: 0.03, noise: 0.09 },
  excluded: { scale: 1, loss: 0.05, family: 0.025, sequence: 0.03, noise: 0.08 },
};
const PART_A_CAL = one({ loss: 0.05, family: 0.6, sequence: 0.15, noise: 0.5 });
const PART_B_CAL = one({ loss: 0.05, family: 0.02, sequence: 0.01, noise: 0.12 });
const NO_FAMILY_CAL = one({ loss: 0.05, family: 0, sequence: 0.03, noise: 0.09 });
const LAYOUT = Array.from({ length: 29 }, (_, i) => ({ repo: `q${i}`, k: 2 + (i % 7) }));

const layoutOf = (units: Unit[]) => {
  const families = new Map<string, Set<string>>();
  for (const u of units) families.set(u.repo, (families.get(u.repo) ?? new Set()).add(u.family));
  return [...families].map(([repo, set]) => ({ repo, k: set.size }));
};
const renamed = (units: Unit[], tag: string): Unit[] => units.map((u) => ({ ...u, repo: `${u.repo}-${tag}`, family: `${u.family}-${tag}` }));

describe('Z0 round 4 simulation engine: round 3 stays as it was', () => {
  // Literals taken from the z0/r4 head (afafc5494) before the engine changed.
  const cal = {
    violation: { scale: 0.8, loss: 0.05, family: 0.04, sequence: 0.02, noise: 0.1 },
    excluded: { scale: 1, loss: 0.05, family: 0.03, sequence: 0.02, noise: 0.08 },
  };
  const total = (us: Unit[]) => us.reduce((s, u) => s + u.value, 0);

  it('repeatRun draws the same units at a fixed count and under a rule', () => {
    const fixed = repeatRun(cal, { repos: 4, families: 3, seeds: 3 }, 0.1, seededRandom(7));
    expect(fixed).not.toHaveProperty('stat');
    expect([fixed.seeds, fixed.stopped]).toEqual([3, false]);
    expect(fixed.units.violation).toHaveLength(35);
    expect(total(fixed.units.violation)).toBe(2.1346898900813835);
    expect([fixed.units.violation[0]!.value, fixed.units.violation.at(-1)!.value]).toEqual([0.11723301092815437, 0.13268720406617598]);
    expect(total(fixed.units.excluded)).toBe(2.9140750058011164);
    expect([fixed.units.excluded[0]!.value, fixed.units.excluded.at(-1)!.value]).toEqual([0.13029347005779066, 0.12962017421906474]);
    const ruled = repeatRun(cal, { repos: 4, families: 3 }, 0.1, seededRandom(11), { m: 0.15, cap: 9, targetZ: 3.5, onMiss: 'cap' });
    expect([ruled.seeds, ruled.stopped, ruled.units.violation.length]).toEqual([9, false, 103]);
    expect(total(ruled.units.violation)).toBe(-0.6790005667537163);
    expect(total(ruled.units.excluded)).toBe(2.634303483861084);
    const stopped = repeatRun(cal, { repos: 4, families: 3 }, 0.1, seededRandom(11), { m: 0.001, cap: 5, targetZ: 3.5 });
    expect([stopped.seeds, stopped.stopped, stopped.units.violation.length]).toEqual([3, true, 33]);
  });

  it('seedsNeeded gives the same counts with and without the cap and target options', () => {
    const { units } = repeatRun(cal, { repos: 4, families: 3, seeds: 3 }, 0.1, seededRandom(7));
    const counts = [0.05, 0.1, 0.15, 0.3].map((m) => [seedsNeeded(units.violation, m), seedsNeeded(units.violation, m, { cap: 6, targetZ: 2 })]);
    expect(counts).toEqual([[null, null], [null, null], [null, 5], [4, 3]]);
  });

  it('binaryRun at its default base and shift draws the same 0/1 values', () => {
    const bin = binaryRun(
      { violation: { scale: 0.8, loss: 0.1, family: 0.2, sequence: 0.1, noise: 0.1 }, excluded: { scale: 1, loss: 0.1, family: 0.1, sequence: 0.05, noise: 0.08 } },
      { repos: 4, families: 3, seeds: 3 }, seededRandom(5),
    );
    const text = (us: Unit[]) => us.map((u) => `${u.family}:${u.seed}:${u.value}`).join(' ');
    expect(text(bin.violation)).toBe('r0f0:1:-1 r0f0:2:-1 r0f0:3:1 r0f1:1:0 r0f1:2:-1 r0f1:3:0 r0f2:1:-1 r0f2:2:0 r0f2:3:0 r1f0:2:0 r1f0:3:0 r1f1:1:-1 r1f1:2:0 r1f1:3:0 r1f2:1:0 r1f2:2:1 r1f2:3:0 r2f0:1:1 r2f0:2:0 r2f0:3:0 r2f1:1:0 r2f1:2:-1 r2f1:3:1 r2f2:1:0 r2f2:2:-1 r2f2:3:-1 r3f0:1:1 r3f0:2:1 r3f0:3:0 r3f1:1:1 r3f1:2:-1 r3f1:3:0 r3f2:1:0 r3f2:2:0 r3f2:3:0');
    expect(text(bin.excluded)).toBe('r0f0:1:-1 r0f0:2:-1 r0f0:3:1 r0f1:1:0 r0f1:2:-1 r0f1:3:0 r0f2:1:-1 r0f2:2:0 r0f2:3:0 r1f0:2:0 r1f0:3:0 r1f1:1:-1 r1f1:2:0 r1f1:3:0 r1f2:1:0 r1f2:2:1 r1f2:3:-1 r2f0:1:1 r2f0:2:0 r2f0:3:0 r2f1:1:0 r2f1:2:-1 r2f1:3:1 r2f2:1:0 r2f2:2:-1 r2f2:3:-1 r3f0:1:1 r3f0:2:1 r3f0:3:0 r3f1:1:0 r3f1:2:-1 r3f1:3:0 r3f2:1:-1 r3f2:2:0 r3f2:3:0');
  });
});

describe('Z0 round 4 simulation engine: the Sizer recovery', () => {
  const cases = [['repeat-shaped', REPEAT_CAL], ['part (a)-shaped', PART_A_CAL], ['part (b)-shaped', PART_B_CAL], ['no family part', NO_FAMILY_CAL]] as const;
  it.each(cases.flatMap(([name, cal]) => [3, 9].map((seeds) => [name, cal, seeds] as const)))(
    'unclampedSpreads gives back each part of the %s calibration at %i seeds',
    (_name, cal, seeds) => {
      const rand = seededRandom(20261110 + seeds);
      const sums = CODINGS.map(() => ({ family: 0, sequence: 0, noise: 0 }));
      const sims = 2000;
      for (let i = 0; i < sims; i++) {
        const run = repeatRun(cal, { layout: LAYOUT, seeds }, 0, rand);
        CODINGS.forEach((coding, c) => {
          const got = unclampedSpreads(run.units[coding])!;
          for (const part of ['family', 'sequence', 'noise'] as const) sums[c]![part] += got[part] / sims;
        });
      }
      CODINGS.forEach((coding, c) => {
        const truth = cal[coding];
        const whole = truth.family + truth.sequence + truth.noise;
        for (const part of ['family', 'sequence', 'noise'] as const) {
          expect(Math.abs(sums[c]![part] - truth[part]), `${coding} ${part}: ${sums[c]![part]} against ${truth[part]}`).toBeLessThanOrEqual(Math.max(0.05 * truth[part], 0.02 * whole));
        }
      });
    },
  );

  it('keeps the unclamped parts out of spreadComponents, which z0-size.mjs writes to its JSON', () => {
    const units = repeatRun(REPEAT_CAL, { layout: LAYOUT, seeds: 3 }, 0, seededRandom(3)).units.violation;
    expect(Object.keys(spreadComponents(units, 0.05)!).sort()).toEqual(['df', 'families', 'family', 'kBar', 'noise', 'repos', 'sBar', 'sequence', 'units', 'upper']);
    expect(unclampedSpreads([])).toBeNull();
  });
});

describe('Z0 round 4 simulation engine: layouts and predicted error', () => {
  const u10 = repeatRun(REPEAT_CAL, { repos: 10, families: 4, seeds: 3 }, 0, seededRandom(31)).units.violation;
  const m = 0.083;

  it('draws the layout\'s repositories with k families each, under both codings', () => {
    const layout = [{ repo: 'a', k: 2 }, { repo: 'b', k: 5 }];
    const run = repeatRun(one({ family: 0.1, sequence: 0.1, noise: 0.1 }), { layout, seeds: 3 }, 0, seededRandom(1));
    for (const coding of CODINGS) {
      expect(layoutOf(run.units[coding])).toEqual(layout);
      expect(run.units[coding]).toHaveLength(7 * 3);
    }
    const binary = binaryRun(one({ family: 0.1, sequence: 0.1, noise: 0.1 }), { layout, seeds: 2 }, seededRandom(1));
    expect(layoutOf(binary.violation)).toEqual(layout);
    expect(binary.violation).toHaveLength(7 * 2);
  });

  it('gives three renamed copies of a 10-repository set the count of the 30-repository set at the same spreads', () => {
    const u30 = [...renamed(u10, 'a'), ...renamed(u10, 'b'), ...renamed(u10, 'c')];
    expect(layoutOf(u30)).toHaveLength(30);
    const count = seedsNeeded(u30, m);
    expect(count).toBeGreaterThan(3);
    expect(seedsNeeded(u10, m, { layout: layoutOf(u30) })).toBe(count);
    for (const seeds of [3, 5, 9]) expect(predictedSe(u10, seeds, { layout: layoutOf(u30) })).toBeCloseTo(predictedSe(u30, seeds)!, 12);
  });

  it('gives a 29-entry layout the count the formula gives from the units\' own spreads by hand', () => {
    const { family, sequence, noise } = spreadComponents(u10, 0.05)!;
    const variance = (seeds: number) => sum(LAYOUT.map(({ k }) => family / k + sequence / seeds + noise / (k * seeds))) / LAYOUT.length ** 2;
    const byHand = [3, 4, 5, 6, 7, 8, 9].find((seeds) => Math.sqrt(variance(seeds)) <= m / 3.5) ?? null;
    expect(byHand).not.toBeNull();
    expect(byHand).toBeGreaterThan(3);
    expect(seedsNeeded(u10, m, { layout: LAYOUT })).toBe(byHand);
    expect(predictedSe(u10, 5, { layout: LAYOUT })).toBeCloseTo(Math.sqrt(variance(5)), 12);
    expect(seedsNeeded(u10, m, { layout: LAYOUT })).not.toBe(seedsNeeded(u10, m));
  });

  it('hands design.layout to the rule, so the run stops at the layout\'s count', () => {
    const design = { layout: LAYOUT };
    const rule = { m, cap: 9, targetZ: 3.5, onMiss: 'cap' as const };
    const first = repeatRun(REPEAT_CAL, { ...design, seeds: 3 }, 0, seededRandom(5)).units;
    const expected = Math.max(...CODINGS.map((c) => ruleSeeds(first[c], { ...rule, layout: LAYOUT }) ?? 9));
    const run = repeatRun(REPEAT_CAL, design, 0, seededRandom(5), rule);
    expect(run.seeds).toBe(expected);
    expect(run.stopped).toBe(false);
  });

  it('reports no prediction when nothing can be fitted', () => {
    expect(predictedSe([], 3)).toBeNull();
    expect(ruleSeeds([], { m, cap: 9, targetZ: 3.5 })).toBeNull();
    expect(ruleSeeds([], { m, cap: 9, targetZ: 3.5, onMiss: 'cap' })).toBe(9);
  });
});

describe('Z0 round 4 simulation engine: the near branch of the rule', () => {
  const rule = { m: 0.04, cap: 9, targetZ: 3.08 };
  const fewest = (units: Unit[], limit: number) => [3, 4, 5, 6, 7, 8, 9].find((seeds) => predictedSe(units, seeds)! <= limit) ?? null;

  it('gives 3 where a large family part makes the cap buy almost nothing, and the cap and null under the other misses', () => {
    const units = repeatRun(one({ family: 0.8, sequence: 0.02, noise: 0.05 }), { repos: 10, families: 3, seeds: 3 }, 0, seededRandom(8)).units.violation;
    expect(fewest(units, rule.m / rule.targetZ)).toBeNull();
    expect(ruleSeeds(units, { ...rule, onMiss: 'stop' })).toBeNull();
    expect(ruleSeeds(units, rule)).toBeNull();
    expect(ruleSeeds(units, { ...rule, onMiss: 'cap' })).toBe(9);
    const near = ruleSeeds(units, { ...rule, onMiss: 'near', near: 1.1 });
    expect(near).toBe(fewest(units, 1.1 * predictedSe(units, 9)!));
    expect(near).toBe(3);
  });

  it('gives the fewest seeds within 1.1 times the cap\'s error when seeds still help', () => {
    const units = repeatRun(one({ family: 0.05, sequence: 0.3, noise: 0.3 }), { repos: 10, families: 3, seeds: 3 }, 0, seededRandom(9)).units.violation;
    expect(fewest(units, rule.m / rule.targetZ)).toBeNull();
    const near = ruleSeeds(units, { ...rule, onMiss: 'near', near: 1.1 });
    expect(near).toBe(fewest(units, 1.1 * predictedSe(units, 9)!));
    expect(near).toBeGreaterThan(3);
    expect(near).toBeLessThan(9);
    expect(predictedSe(units, near! - 1)!).toBeGreaterThan(1.1 * predictedSe(units, 9)!);
    expect(ruleSeeds(units, { ...rule, onMiss: 'near', near: 1.1, layout: LAYOUT })).toBe(
      [3, 4, 5, 6, 7, 8, 9].find((seeds) => predictedSe(units, seeds, { layout: LAYOUT })! <= 1.1 * predictedSe(units, 9, { layout: LAYOUT })!),
    );
  });

  it('takes the first count that meets the bar when the rule does not miss, whatever onMiss says', () => {
    const units = repeatRun(REPEAT_CAL, { repos: 10, families: 4, seeds: 3 }, 0, seededRandom(31)).units.violation;
    const hit = ruleSeeds(units, { m: 0.083, cap: 9, targetZ: 3.5, layout: LAYOUT });
    expect(hit).toBe(7);
    for (const onMiss of ['stop', 'cap', 'near'] as const) expect(ruleSeeds(units, { m: 0.083, cap: 9, targetZ: 3.5, layout: LAYOUT, onMiss, near: 1.1 })).toBe(hit);
    expect(() => ruleSeeds(units, { ...rule, onMiss: 'near' })).toThrow(/near/);
  });
});

describe('Z0 round 4 simulation engine: exact draws and scored draws', () => {
  const flat = { violation: { scale: 0.8, loss: 0, family: 0, sequence: 0, noise: 0 }, excluded: { scale: 1, loss: 0, family: 0, sequence: 0, noise: 0 } };

  it('puts every cell at delta under every coding with exact, and at scale x delta without it', () => {
    const design = { layout: [{ repo: 'a', k: 3 }, { repo: 'b', k: 3 }], seeds: 3 };
    const exact = repeatRun(flat, design, 0.15, seededRandom(1), null, { exact: true });
    for (const coding of CODINGS) expect(new Set(exact.units[coding].map((u: Unit) => u.value))).toEqual(new Set([0.15]));
    const scaled = repeatRun(flat, design, 0.15, seededRandom(1));
    expect(new Set(scaled.units.violation.map((u: Unit) => u.value))).toEqual(new Set([0.8 * 0.15]));
    expect(new Set(scaled.units.excluded.map((u: Unit) => u.value))).toEqual(new Set([0.15]));
  });

  it('adds stat only when a score is asked for, and scores repeat draws by fixedRepositoryT', () => {
    const design = { layout: LAYOUT, seeds: 3 };
    const plain = repeatRun(REPEAT_CAL, design, 0, seededRandom(2));
    expect(plain).not.toHaveProperty('stat');
    const scored = repeatRun(REPEAT_CAL, design, 0, seededRandom(2), null, { score: 'repeat' });
    expect(scored.units).toEqual(plain.units);
    for (const coding of CODINGS) {
      const by = fixedRepositoryT(plain.units[coding], 0);
      expect(scored.stat[coding]).toEqual({ estimate: by.estimate, se: by.se, df: by.df });
    }
  });

  it('scores ratio draws as the plain mean of every cell with weightedVariance\'s error', () => {
    const scored = repeatRun(PART_A_CAL, { layout: LAYOUT, seeds: 3 }, Math.log(0.5), seededRandom(4), null, { score: 'ratio', exact: true });
    for (const coding of CODINGS) {
      const units: Unit[] = scored.units[coding];
      const spread = weightedVariance(units, units.map((u) => u.value))!;
      expect(scored.stat[coding].estimate).toBeCloseTo(sum(units.map((u) => u.value)) / units.length, 12);
      expect(scored.stat[coding].se).toBeCloseTo(Math.sqrt(spread.v), 12);
      expect(scored.stat[coding].df).toBeCloseTo(spread.df, 12);
    }
  });

  it('scores a stopped run as no estimate', () => {
    const run = repeatRun(one({ family: 1, sequence: 0, noise: 0.01 }), { layout: LAYOUT }, 0, seededRandom(1), { m: 0.001, cap: 5, targetZ: 3.5 }, { score: 'repeat' });
    expect(run.stopped).toBe(true);
    expect(run.stat).toBeNull();
  });
});

describe('Z0 round 4 simulation engine: sizes at the null', () => {
  const sims = 2000;
  const nominal = 0.05;
  const cases = [
    ['T1', 0, 0.3, REPEAT_CAL], ['T2b', -0.03, 0.9, PART_B_CAL], ['T2b', -0.03, 0.5, PART_B_CAL], ['T2c', 0.15, 0.3, REPEAT_CAL],
  ] as const;
  it.each(cases)('binaryRun for %s at shift %f and base %f has a size within 3 simulation errors of 0.05', (test, shift, base, cal) => {
    const rand = seededRandom(20261110);
    const rejects = CODINGS.map(() => 0);
    for (let i = 0; i < sims; i++) {
      const units = binaryRun(cal, { layout: LAYOUT, seeds: 3 }, rand, { base, shift });
      CODINGS.forEach((coding, c) => {
        const { estimate, se, df } = fixedRepositoryT(units[coding], 0);
        if (scoreTest({ estimate, se, df }, { ...T_NULLS[test], level: nominal }).p < nominal) rejects[c]!++;
      });
    }
    const simError = Math.sqrt((nominal * (1 - nominal)) / sims);
    CODINGS.forEach((coding, c) => expect(Math.abs(rejects[c]! / sims - nominal), `${coding} size ${rejects[c]! / sims}`).toBeLessThanOrEqual(3 * simError));
  });

  it('keeps each cell\'s true mean at the shift, with the control\'s rate clamped so the treatment stays inside [0.02, 0.98]', () => {
    const wide = one({ family: 0.5, sequence: 0.5, noise: 0 });
    for (const shift of [-0.03, 0, 0.15]) {
      const rand = seededRandom(3);
      const values = Array.from({ length: 600 }, () => binaryRun(wide, { layout: [{ repo: 'a', k: 4 }, { repo: 'b', k: 4 }], seeds: 3 }, rand, { base: 0.9, shift }).violation.map((u: Unit) => u.value)).flat();
      expect(values.every((v) => v === -1 || v === 0 || v === 1)).toBe(true);
      expect(Math.abs(sum(values) / values.length - shift)).toBeLessThan(0.03);
    }
  });

  it('resamples cost cells with the arms swapped so the mean log ratio sits at 0', () => {
    const cells = costCells(5, 8, 3);
    const rand = seededRandom(17);
    const estimates: number[] = [];
    for (let i = 0; i < sims; i++) {
      const got = resampledRun(cells, rand, 'a');
      if (got !== null) estimates.push(got.estimate);
    }
    expect(estimates.length).toBeGreaterThan(sims * 0.9);
    const m = sum(estimates) / estimates.length;
    const simError = Math.sqrt(sum(estimates.map((x) => (x - m) ** 2)) / (estimates.length - 1) / estimates.length);
    expect(Math.abs(m), `mean ${m}, simulation error ${simError}`).toBeLessThanOrEqual(3 * simError);
  });

  it('resamples resolve differences with 0.03 taken off, so part (b)\'s mean estimate sits at -0.03', () => {
    const rand = seededRandom(19);
    const cells = valueCells(8, 6, 3);
    const estimates = Array.from({ length: sims }, () => resampledRun(cells, rand, 'b')!.estimate);
    const m = sum(estimates) / sims;
    const simError = Math.sqrt(sum(estimates.map((x) => (x - m) ** 2)) / (sims - 1) / sims);
    expect(Math.abs(m + 0.03), `mean ${m}, simulation error ${simError}`).toBeLessThanOrEqual(3 * simError);
  });

  it("draws each repository's families with replacement, swaps whole copies and takes the 0.03 off every value", () => {
    // rand() = 0 picks family 0 for every draw and swaps it; rand() = 0.99 picks the last family and keeps it.
    const rows = (values: Record<string, number[]>) => ['a', 'b'].flatMap((repo) => Object.entries(values).flatMap(([family, vs]) => vs.map((value, i) => ({ repo, family, seed: i + 1, value }))));
    const costRows = (costs: Record<string, [number, number]>) => ['a', 'b'].flatMap((repo) => Object.entries(costs).flatMap(([family, [Ct, Cc]]) => [1, 2].map((seed) => ({ repo, family, seed, Ct, Cc, St: 1, Sc: 1 }))));
    const cells = rows({ f0: [0.1, 0.3], f1: [0.9, 0.7] });
    expect(resampledRun(cells, () => 0, 'b')!.estimate).toBeCloseTo(-(0.1 + 0.3) / 2 - 0.03, 12);
    expect(resampledRun(cells, () => 0.99, 'b')!.estimate).toBeCloseTo((0.9 + 0.7) / 2 - 0.03, 12);
    const cost = costRows({ f0: [2, 1], f1: [1, 1] });
    expect(resampledRun(cost, () => 0, 'a')!.estimate).toBeCloseTo(-Math.log(2), 12);
    expect(resampledRun(cost, () => 0.99, 'a')!.estimate).toBeCloseTo(Math.log(1), 12);
    expect(resampledRun(cost.map((c) => ({ ...c, St: 0 })), () => 0.99, 'a')).toBeNull();
  });
});

describe('Z0 round 4 simulation engine: levelSearch', () => {
  const cell = (setting: string, n: number, below: [number, number][]) => {
    const ps = Array.from({ length: n }, () => 0.5);
    let at = 0;
    for (const [count, p] of below) for (let i = 0; i < count; i++) ps[at++] = p;
    return { setting, ps, noEstimate: 0 };
  };

  it('gives the level where the sizes cross the threshold, names the blocking cell, and reports sizes and errors', () => {
    const quiet = cell('quiet', 1000, [[10, 0.001]]);
    const blocking = cell('blocking', 1000, [[25, 0.0225], [1, 0.0235]]);
    const found = levelSearch([quiet, blocking], 0.025);
    expect(found.level).toBe(0.023);
    expect(found.setBy).toMatchObject({ setting: 'blocking', at: 0.024, size: 0.026 });
    expect(found.cells.map((c: { setting: string }) => c.setting)).toEqual(['quiet', 'blocking']);
    expect(found.cells[0]).toEqual({ setting: 'quiet', size: 0.01, simError: Math.sqrt((0.01 * 0.99) / 1000) });
    expect(found.cells[1]).toEqual({ setting: 'blocking', size: 0.025, simError: Math.sqrt((0.025 * 0.975) / 1000) });
  });

  it('gives the threshold when no cell crosses it, and names the cell with the largest size there', () => {
    const found = levelSearch([cell('low', 1000, [[5, 0.001]]), cell('high', 1000, [[20, 0.001]])], 0.025);
    expect(found.level).toBe(0.025);
    expect(found.setBy).toMatchObject({ setting: 'high', at: 0.025, size: 0.02 });
    expect(found.cells.map((c: { size: number }) => c.size)).toEqual([0.005, 0.02]);
    expect(levelSearch([cell('even', 2000, [[40, 0.04]])], 0.05).level).toBe(0.05);
  });

  it('gives 0 when even level 0.001 fails, with every size 0', () => {
    const found = levelSearch([cell('bad', 1000, [[100, 0.0005]])], 0.025);
    expect(found.level).toBe(0);
    expect(found.setBy).toMatchObject({ setting: 'bad', at: 0.001, size: 0.1 });
    expect(found.cells).toEqual([{ setting: 'bad', size: 0, simError: 0 }]);
  });

  it('counts a p strictly below the level, so a p equal to it does not count', () => {
    const found = levelSearch([cell('edge', 1000, [[26, 0.023]])], 0.025);
    expect(found.level).toBe(0.023);
    expect(found.cells[0].size).toBe(0);
  });

  it('refuses a cell with no draws', () => {
    expect(() => levelSearch([{ setting: 'empty', ps: [], noEstimate: 0 }], 0.05)).toThrow(/draws/);
  });
});

type CostCell = { repo: string; family: string; seed: number; Ct: number; Cc: number; St: number; Sc: number };

/** Skewed cost cells with both arms solving about 60% of the time. */
function costCells(repos: number, families: number, seeds: number) {
  const rand = seededRandom(101);
  const cells: CostCell[] = [];
  for (let r = 0; r < repos; r++) {
    for (let f = 0; f < families; f++) {
      const familyScale = Math.exp(0.8 * normal(rand));
      for (let s = 1; s <= seeds; s++) {
        const cost = () => familyScale * Math.exp(1.2 * normal(rand));
        cells.push({ repo: `r${r}`, family: `r${r}f${f}`, seed: s, Ct: cost(), Cc: cost(), St: Number(rand() < 0.6), Sc: Number(rand() < 0.6) });
      }
    }
  }
  return cells;
}

/** Resolve-difference cells in {-1, 0, 1} with a small family part. */
function valueCells(repos: number, families: number, seeds: number) {
  const rand = seededRandom(103);
  const cells: Unit[] = [];
  for (let r = 0; r < repos; r++) {
    for (let f = 0; f < families; f++) {
      for (let s = 1; s <= seeds; s++) cells.push({ repo: `r${r}`, family: `r${r}f${f}`, seed: s, value: Number(rand() < 0.5) - Number(rand() < 0.5) });
    }
  }
  return cells;
}

describe('Z0 round 4 simulation engine: levelCells', () => {
  const small = [{ repo: 'a', k: 3 }, { repo: 'b', k: 4 }, { repo: 'c', k: 2 }];
  const fixedAt = (where: string) => [3, 4, 5, 6, 7, 8, 9].map((n) => `${n} seeds at ${where}`);
  const normalCases = ['rule at point', 'rule at upper', ...fixedAt('point'), ...fixedAt('upper')];
  const both = (cases: string[]) => cases.flatMap((name) => CODINGS.map((coding) => `${name} (${coding})`));
  const expected = {
    T1: both([...normalCases, '0/1 base 0.3 at upper']),
    T3: both([...normalCases, '0/1 base 0.3 at upper']),
    T2c: both([...normalCases, '0/1 base 0.3 at upper']),
    T2a: [...normalCases, 'resampled'],
    T2b: [...normalCases, '0/1 base 0.9 at upper', '0/1 base 0.5 at upper', 'resampled'],
  };
  const spec = (test: string, extra = {}) => ({
    test, calPoint: REPEAT_CAL, calUpper: { violation: { ...REPEAT_CAL.violation, family: 0.04 }, excluded: { ...REPEAT_CAL.excluded, family: 0.05 } }, layout: small,
    rule: { m: 0.15, cap: 9, targetZ: 3.5, near: 1.1 }, sims: 50, seed: 20261110, label: 'unit',
    resampled: test === 'T2a' ? costCells(4, 4, 3) : test === 'T2b' ? valueCells(4, 4, 4) : undefined, ...extra,
  });

  it.each(Object.entries(expected))('lists the cells of %s and no others, each with sims p values', (test, settings) => {
    const cells = levelCells(spec(test));
    expect(cells.map((c: { setting: string }) => c.setting)).toEqual(settings);
    for (const c of cells) {
      expect(c.ps).toHaveLength(50);
      expect(c.ps.every((p: number) => p >= 0 && p <= 1)).toBe(true);
      expect(Number.isInteger(c.noEstimate)).toBe(true);
    }
  });

  it('keeps only the cases it is given, under both codings where the test has two', () => {
    expect(levelCells(spec('T1', { cases: ['rule at upper', '5 seeds at point'] })).map((c: { setting: string }) => c.setting)).toEqual([
      'rule at upper (violation)', 'rule at upper (excluded)', '5 seeds at point (violation)', '5 seeds at point (excluded)',
    ]);
    expect(levelCells(spec('T2a', { cases: ['rule at upper'] })).map((c: { setting: string }) => c.setting)).toEqual(['rule at upper']);
  });

  it('draws the same ps from the same spec, and others from another seed or label', () => {
    expect(levelCells(spec('T2b'))).toEqual(levelCells(spec('T2b')));
    expect(levelCells(spec('T2b', { seed: 5 }))).not.toEqual(levelCells(spec('T2b')));
    expect(levelCells(spec('T2b', { label: 'other' }))).not.toEqual(levelCells(spec('T2b')));
  });

  it('draws each case from its own cellSeed, with the rule cells at the near count for T2a and at the cap for the others', () => {
    const heavy = one({ family: 0.05, sequence: 0.3, noise: 0.3 });
    const rule = { m: 0.04, cap: 9, targetZ: 3.5, near: 1.1 };
    for (const [test, onMiss, score] of [['T2a', 'near', 'ratio'], ['T1', 'cap', 'repeat']] as const) {
      const [cell] = levelCells(spec(test, { calPoint: heavy, calUpper: heavy, rule, cases: ['rule at upper'] }));
      const rand = seededRandom(cellSeed(20261110, 'level4', 'unit', test, 'rule at upper'));
      const ps = Array.from({ length: 50 }, () => {
        const { stat } = repeatRun(heavy, { layout: small }, T_NULLS[test].nullValue, rand, { ...rule, onMiss }, { score, exact: true });
        return scoreTest(stat.violation, { ...T_NULLS[test], level: 0.05 }).p;
      });
      expect(cell.ps).toEqual(ps);
    }
  });

  it('draws every normal cell at the test\'s null, whatever the codings\' scales', () => {
    const flat = { violation: { scale: 0.8, loss: 0, family: 0, sequence: 0, noise: 0 }, excluded: { scale: 0.9, loss: 0, family: 0, sequence: 0, noise: 0 } };
    for (const test of ['T1', 'T2b', 'T2c']) {
      const cells = levelCells(spec(test, { calPoint: flat, calUpper: flat, cases: ['rule at point', '4 seeds at upper'] }));
      expect(cells.length).toBeGreaterThan(0);
      for (const c of cells) expect(c.ps.every((p: number) => p === 1)).toBe(true);
    }
  });

  it('counts a draw with no estimate as p = 1 and tallies it', () => {
    const noSolves = costCells(3, 4, 3).map((c) => ({ ...c, St: 0, Sc: 0 }));
    const [cell] = levelCells(spec('T2a', { cases: ['resampled'], resampled: noSolves }));
    expect(cell.ps).toEqual(Array.from({ length: 50 }, () => 1));
    expect(cell.noEstimate).toBe(50);
  });

  it('drops resampled cells with seed above 3', () => {
    const cells = costCells(3, 4, 6);
    expect(levelCells(spec('T2a', { cases: ['resampled'], resampled: cells }))).toEqual(levelCells(spec('T2a', { cases: ['resampled'], resampled: cells.filter((c) => c.seed <= 3) })));
  });

  it('refuses a test it does not know', () => {
    expect(() => levelCells(spec('H4'))).toThrow(/H4/);
  });
});
