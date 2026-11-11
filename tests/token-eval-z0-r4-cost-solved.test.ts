// Round 4 prereg items 2 and 3: cost per solved task (R, v, its weighted variance), part (b)'s cell values and the pooled solve difference.
import { describe, it, expect, vi } from 'vitest';
import { seededRandom } from '../dist/eval/eval-stats.js';
import { fixedRepositoryRatioT, fixedRepositoryT, pooledComponents } from '../dist/eval/repository-t.js';
import { DESIGNS, OPUS_MODEL } from '../scripts/token-eval/arms.mjs';
import { sourceRows } from '../scripts/token-eval/z0-blind.mjs';
import { bootstrapRatio, cellValues, cellsOf, costCells, costSolvedRatio, costSolvedT, partBValues, pooledSolveDiff, resolveDiff, usageRatio, weightedVariance } from '../scripts/token-eval/z0-cost-solved.mjs';
import { harmT, inSets, ratioT, taskUnits } from '../scripts/token-eval/z0-hypotheses.mjs';
import { parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { PRICES, PRICES_BY_MODEL, generate, jsonl, type Usage, type Z0Record } from './fixtures/z0-gen.js';

// The 20,000-table simulation fits 20,000 tables, which the 5 s default cannot hold.
vi.setConfig({ testTimeout: 120_000 });

interface Cell { repo: string; family: string; seed: number; Ct: number; Cc: number; St: number; Sc: number }
const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const cell = (repo: string, family: string, seed: number, Ct: number, Cc: number, St: number, Sc: number): Cell => ({ repo, family, seed, Ct, Cc, St, Sc });
const ratioCells = (cells: readonly Cell[]) => cells.map((c) => ({ repo: c.repo, family: c.family, seed: c.seed, t: c.Ct, c: c.Cc }));

interface Layout { repo: string; families: number; seeds: number; missing?: readonly (readonly [number, number])[] }
const LAYOUT: readonly Layout[] = [
  { repo: 'r1', families: 5, seeds: 3 },
  { repo: 'r2', families: 4, seeds: 3, missing: [[2, 1]] },
  { repo: 'r3', families: 6, seeds: 3, missing: [[0, 0], [3, 2], [5, 1]] },
  { repo: 'r4', families: 3, seeds: 2 },
  { repo: 'r5', families: 1, seeds: 3 },
];
const slots = (layout: readonly Layout[]) => layout.flatMap((l) => Array.from({ length: l.families * l.seeds }, (_, i) => ({ repo: l.repo, f: Math.floor(i / l.seeds), s: i % l.seeds }))
  .filter(({ f, s }) => !(l.missing ?? []).some(([mf, ms]) => mf === f && ms === s)));

/** Positive costs and 0 to 3 solves from a seeded stream; `equalSolves` gives both arms the same solves in every cell. */
function table(layout: readonly Layout[], seed: number, equalSolves = false): Cell[] {
  const rand = seededRandom(seed);
  return slots(layout).map(({ repo, f, s }) => {
    const Cc = 5 + 5 * rand();
    const St = Math.floor(rand() * 4);
    return cell(repo, `${repo}-f${f}`, s + 1, Cc * (0.7 + 0.5 * rand()), Cc, St, equalSolves ? St : Math.floor(rand() * 4));
  });
}

describe('R and v on a hand-made table', () => {
  // Sums: Ct 28, Cc 24, St 4, Sc 2, so R = (28 x 2) / (24 x 4) = 7/12; means 7, 6, 1, 0.5.
  const HAND = [cell('r1', 'f1', 1, 10, 8, 2, 1), cell('r1', 'f2', 1, 6, 4, 1, 0), cell('r1', 'f3', 1, 8, 8, 1, 1), cell('r1', 'f4', 1, 4, 4, 0, 0)];

  it('gives R from the four sums', () => {
    expect(costSolvedRatio(HAND)).toBeCloseTo(7 / 12, 14);
  });

  it('gives v as the linear form over cell means, each term by hand', () => {
    // cell 1: 10/7 - 8/6 - 2/1 + 1/0.5 = 2/21; cell 2: 6/7 - 4/6 - 1 = -17/21; cell 3: 8/7 - 8/6 - 1 + 2 = 17/21; cell 4: 4/7 - 4/6 = -2/21.
    const v = cellValues(HAND);
    [2 / 21, -17 / 21, 17 / 21, -2 / 21].forEach((want, i) => expect(v[i]).toBeCloseTo(want, 14));
    expect(sum(v)).toBeCloseTo(0, 14);
  });

  it('keeps a cell with 0 solves in the sums and in v', () => {
    expect(HAND[3]!.St + HAND[3]!.Sc).toBe(0);
    expect(cellValues(HAND).every(Number.isFinite)).toBe(true);
    const big = [...table(LAYOUT, 3), cell('r1', 'r1-zero', 1, 4, 5, 0, 0)];
    const t = costSolvedT(big);
    expect(Number.isFinite(t.estimate)).toBe(true);
    expect(t.estimate).toBeCloseTo(Math.log(costSolvedRatio(big)), 14);
  });

  it('gives no estimate when either side has 0 solves', () => {
    const noTreatment = table(LAYOUT, 4).map((c) => ({ ...c, St: 0 }));
    const noControl = table(LAYOUT, 4).map((c) => ({ ...c, Sc: 0 }));
    for (const cells of [noTreatment, noControl]) {
      expect(costSolvedRatio(cells)).toBeNaN();
      expect(costSolvedT(cells)).toEqual({ estimate: null, reason: '0 solves' });
    }
  });
});

describe('R and the variance against fixedRepositoryRatioT', () => {
  it('equals the same ratio when the solve totals match', () => {
    const cells = table(LAYOUT, 5);
    const balanced = cells.map((c, i) => (i === 0 ? { ...c, Sc: c.Sc + sum(cells.map((x) => x.St)) - sum(cells.map((x) => x.Sc)) } : c));
    expect(sum(balanced.map((c) => c.St))).toBe(sum(balanced.map((c) => c.Sc)));
    expect(costSolvedRatio(balanced)).toBeCloseTo(fixedRepositoryRatioT(ratioCells(balanced)).estimate, 12);
  });

  it('gives its variance and df with equal cells per repository, complete tables and equal solves in each cell', () => {
    const even: Layout[] = ['r1', 'r2', 'r3', 'r4'].map((repo) => ({ repo, families: 4, seeds: 3 }));
    const cells = table(even, 6, true);
    const theirs = fixedRepositoryRatioT(ratioCells(cells));
    const mine = weightedVariance(cells, cellValues(cells));
    expect(mine!.v).toBeCloseTo(theirs.se! ** 2, 12);
    expect(mine!.df).toBeCloseTo(theirs.df!, 9);
  });
});

/** Item 3's sum from the pooled mean squares, with the counts taken straight from the table. */
function itemThree(cells: readonly Cell[], values: readonly number[]) {
  const pc = pooledComponents(cells.map((c, i) => ({ repo: c.repo, family: c.family, seed: c.seed, value: values[i]! })))!;
  const n = cells.length;
  const squares = (key: (c: Cell) => string): number => {
    const counts = new Map<string, number>();
    for (const c of cells) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
    return sum([...counts.values()].map((k) => k * k));
  };
  const useQ = pc.Q > pc.E;
  const family = squares((c) => `${c.repo}/${c.family}`) / (n * n * pc.sBar);
  const seed = useQ ? squares((c) => `${c.repo}/${c.seed}`) / (n * n * pc.kBar) : 0;
  const terms = [[family * pc.F, pc.dfF], [seed * pc.Q, pc.dfQ], [(1 / n - family - seed) * pc.E, pc.dfE]].filter(([x]) => x !== 0);
  const v = sum(terms.map(([x]) => x!));
  return { v: v > 0 ? v : family * pc.F, df: v > 0 ? (v * v) / sum(terms.map(([x, d]) => (x! * x!) / d!)) : pc.dfF, useQ, pc };
}

describe('the weighted variance with a missing cell and unequal repository sizes', () => {
  const cells = table(LAYOUT, 7);
  const values = cellValues(cells);

  it('has the missing cells and a repository too thin to fit', () => {
    expect(cells.length).toBe(LAYOUT.reduce((s, l) => s + l.families * l.seeds, 0) - 4);
    expect(new Set(cells.filter((c) => c.repo === 'r5').map((c) => c.family)).size).toBe(1);
  });

  it('equals item 3\'s sum by hand, df included', () => {
    const hand = itemThree(cells, values);
    const mine = weightedVariance(cells, values);
    expect(mine!.v).toBeCloseTo(hand.v, 14);
    expect(mine!.df).toBeCloseTo(hand.df, 9);
  });

  it('differs from the one-over-G-squared variance of fixedRepositoryT', () => {
    const plain = fixedRepositoryT(cells.map((c, i) => ({ repo: c.repo, family: c.family, seed: c.seed, value: values[i]! })), 0);
    expect(Math.abs(weightedVariance(cells, values)!.v / plain.se! ** 2 - 1)).toBeGreaterThan(0.01);
  });

  it('drops the seed part when the seed mean square is not above the residual one', () => {
    const noise = seededRandom(7);
    const flat = cells.map((c) => 2 * Number(c.family.slice(-1)) + 0.3 * noise());
    const hand = itemThree(cells, flat);
    expect(hand.useQ).toBe(false);
    expect(weightedVariance(cells, flat)!.v).toBeCloseTo(hand.v, 14);
  });

  it('gives costSolvedT its log R, standard error, df and ratio from that variance', () => {
    const t = costSolvedT(cells);
    const { v, df } = weightedVariance(cells, cellValues(cells))!;
    expect(t.estimate).toBeCloseTo(Math.log(costSolvedRatio(cells)), 14);
    expect(t.se).toBeCloseTo(Math.sqrt(v), 14);
    expect(t.df).toBeCloseTo(df, 9);
    expect(t.ratio).toBeCloseTo(costSolvedRatio(cells), 14);
  });
});

describe('the variance of the pooled mean over 20,000 simulated tables', () => {
  it('is within 5% of the weighted variance, and of item 3\'s exact sum, in under 60 s', () => {
    const started = Date.now();
    const rand = seededRandom(20_261_110);
    const normal = (): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const [sa, sb, se] = [Math.sqrt(0.5), Math.sqrt(0.3), 1];
    const layout = table(LAYOUT, 1);
    const pooled: number[] = [];
    const estimates: number[] = [];
    for (let t = 0; t < 20_000; t++) {
      const family = new Map<string, number>();
      const seed = new Map<string, number>();
      const effect = (m: Map<string, number>, key: string, sd: number): number => {
        if (!m.has(key)) m.set(key, sd * normal());
        return m.get(key)!;
      };
      const values = layout.map((c) => effect(family, `${c.repo}/${c.family}`, sa) + effect(seed, `${c.repo}/${c.seed}`, sb) + se * normal());
      pooled.push(sum(values) / values.length);
      estimates.push(weightedVariance(layout, values)!.v);
    }
    const mean = (xs: readonly number[]): number => sum(xs) / xs.length;
    const observed = mean(pooled.map((x) => (x - mean(pooled)) ** 2)) * (pooled.length / (pooled.length - 1));
    const count = (key: (c: Cell) => string): number => {
      const counts = new Map<string, number>();
      for (const c of layout) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
      return sum([...counts.values()].map((k) => k * k));
    };
    const exact = (0.5 * count((c) => `${c.repo}/${c.family}`) + 0.3 * count((c) => `${c.repo}/${c.seed}`) + layout.length) / layout.length ** 2;
    expect(Math.abs(observed / exact - 1)).toBeLessThan(0.05);
    expect(Math.abs(mean(estimates) / observed - 1)).toBeLessThan(0.05);
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});

const parsed = (records: readonly Z0Record[]) => parseZ0Records(jsonl(records), 'runs.jsonl').records;
const usage = (inputTokens: number, outputTokens: number): Usage => ({ inputTokens, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens });
const price = (u: Usage, row: { inputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number; outputPerMTok: number }): number =>
  (u.inputTokens * row.inputPerMTok + u.cacheWriteTokens * row.cacheWritePerMTok + u.cacheReadTokens * row.cacheReadPerMTok + u.outputTokens * row.outputPerMTok) / 1_000_000;
const SONNET_ROW = PRICES_BY_MODEL.models['claude-sonnet-5-5'];

describe('cells from records', () => {
  const records = parsed(generate({ design: DESIGNS.r4, arms: ['S2', 'O1'], repos: 2, knobs: { S2: { resolve: 0.6 }, O1: { resolve: 0.8 } } }).records);
  const keep = inSets('R', 'N');
  const own = costCells(records, ['S2', 'O1'], PRICES_BY_MODEL, keep, { design: DESIGNS.r4 });

  it('sums each (repository, family, seed) cell over sets R and N, a set N task being a family of one', () => {
    const treatment = records.filter((r) => r.arm === 'S2');
    expect(sum(own.map((c: Cell) => c.Ct))).toBeCloseTo(sum(treatment.map((r) => price(sumUsage(r), SONNET_ROW))), 9);
    expect(sum(own.map((c: Cell) => c.St))).toBe(treatment.filter((r) => r.resolved).length);
    const noLesson = records.find((r) => r.arm === 'S2' && r.set === 'N' && r.seed === 2)!;
    const alone = own.find((c: Cell) => c.repo === noLesson.repo && c.family === `task ${noLesson.taskId}` && c.seed === 2)!;
    expect(alone.Ct).toBeCloseTo(price(sumUsage(noLesson), SONNET_ROW), 12);
    expect(alone.St).toBe(noLesson.resolved ? 1 : 0);
  });

  it('prices the treatment arm at the Opus row when rowModel says so', () => {
    const atOpus = costCells(records, ['S2', 'O1'], PRICES_BY_MODEL, keep, { design: DESIGNS.r4, rowModel: OPUS_MODEL });
    expect(atOpus).toHaveLength(own.length);
    atOpus.forEach((c: Cell, i: number) => {
      expect(c.Ct).toBeCloseTo(own[i].Ct * 2, 12);
      expect(c.Cc).toBeCloseTo(own[i].Cc, 12);
    });
  });

  it('prices both arms at their own rows under the round 3 tool prices when no design is given', () => {
    const r3 = parsed(generate({ knobs: { A2: { resolve: 0.7 } } }).records);
    const cells = costCells(r3, ['A2', 'A1'], PRICES, keep, {});
    expect(sum(cells.map((c: Cell) => c.Ct))).toBeGreaterThan(0);
    expect(costSolvedRatio(cells)).toBeGreaterThan(0);
  });

  it('gives r as the arm\'s usage over the base arm\'s, both at the Opus row, on the tasks both ran', () => {
    const handMade = records.map((r) => ({ ...r, usage: { firstSession: r.arm === 'O1' ? usage(1_000_000, 0) : usage(0, 100_000), extra: usage(0, 0) } }));
    // O1 costs 5.00 a record at the Opus row and S1 2.50, so r is 0.5; at its own Sonnet row S1 would give 0.25.
    const asSonnet = handMade.map((r) => (r.arm === 'S2' ? { ...r, arm: 'S1' } : r));
    expect(usageRatio(asSonnet, 'S1', 'O1', PRICES_BY_MODEL)).toBeCloseTo(0.5, 14);
  });
});

function sumUsage(r: Z0Record): Usage {
  const [a, b] = [r.usage!.firstSession, r.usage!.extra];
  return { inputTokens: a.inputTokens + b.inputTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, outputTokens: a.outputTokens + b.outputTokens };
}

describe('part (b) and the pooled solve difference', () => {
  const records = parsed(generate({ knobs: { A2: { resolve: 0.7 }, A1: { resolve: 0.85 } } }).records);
  const units = taskUnits(records, 'A2', 'A1', PRICES, inSets('R', 'N'));

  it('gives partBValues as harmT\'s resolve cells, so fixedRepositoryT on them is harmT\'s resolve test', () => {
    expect(fixedRepositoryT(partBValues(records, ['A2', 'A1'], inSets('R', 'N')), 0)).toEqual(harmT(units, {}).resolveDiff);
    const setN = units.filter((u: { set: string }) => u.set === 'N');
    expect(fixedRepositoryT(partBValues(records, ['A2', 'A1'], inSets('N')), 0)).toEqual(harmT(setN, {}).resolveDiff);
  });

  it('keeps cellsOf and resolveDiff as harmT built them', () => {
    const cells = cellsOf(units, (us: Parameters<typeof resolveDiff>[0]) => ({ value: resolveDiff(us) }));
    expect(partBValues(records, ['A2', 'A1'], inSets('R', 'N'))).toEqual(cells);
  });

  it('gives the pooled solve difference as the mean over paired tasks, on the seeds kept', () => {
    const mean = (us: readonly { t: { resolved: number }; c: { resolved: number } }[]) => sum(us.map((u) => u.t.resolved - u.c.resolved)) / us.length;
    expect(pooledSolveDiff(records, ['A2', 'A1'], inSets('R', 'N'), [1, 2, 3])).toBeCloseTo(mean(units), 14);
    const first = units.filter((u: { seed: number }) => u.seed === 1);
    expect(pooledSolveDiff(records, ['A2', 'A1'], inSets('R', 'N'), [1])).toBeCloseTo(mean(first), 14);
  });
});

describe('the bootstrap twin', () => {
  const cells = table(LAYOUT, 9);

  it('resamples R over repositories held fixed, and the same seed gives the same draws', () => {
    const [a, b] = [bootstrapRatio(cells, { iterations: 200, seed: 3 }), bootstrapRatio(cells, { iterations: 200, seed: 3 })];
    expect(a).toEqual(b);
    expect(a.estimate).toBeCloseTo(costSolvedRatio(cells), 12);
    expect(a.iterations + a.dropped).toBe(200);
    expect(a.nullValue).toBe(1);
  });
});

describe('the move out of z0-hypotheses.mjs', () => {
  const g = generate({ knobs: { A2: { resolve: 0.7 }, A1: { resolve: 0.85 } } });
  const jitter = seededRandom(11);
  const scaled = (u: Usage, m: number): Usage => ({ inputTokens: Math.round(u.inputTokens * m), cacheWriteTokens: Math.round(u.cacheWriteTokens * m), cacheReadTokens: Math.round(u.cacheReadTokens * m), outputTokens: Math.round(u.outputTokens * m) });
  const moved = g.records.map((r) => {
    const m = (r.arm === 'A2' ? 1.3 : 1) * (0.7 + 0.8 * jitter());
    return r.usage === null ? r : { ...r, usage: { firstSession: scaled(r.usage.firstSession, m), extra: scaled(r.usage.extra, m) } };
  });
  const round12 = <T>(x: T) => JSON.parse(JSON.stringify(x), (_key, v) => (Number.isFinite(v) ? Number(v.toPrecision(12)) : v));

  it('leaves round 3\'s H3 and H4 outputs on one synthetic corpus as they were before the move', () => {
    const records = parsed(moved);
    const units = taskUnits(records, 'A2', 'A1', PRICES, inSets('R', 'N'));
    const opts = { iterations: 60, seed: 7 };
    // Taken from the base commit (094d6196e) before cellsOf, resolveDiff, blocks and byKey moved, rounded to 12 digits.
    expect(round12({ h4: harmT(units.filter((u: { set: string }) => u.set === 'N'), opts), h3: ratioT(units, 'cost', opts), n: units.length })).toEqual(BEFORE_THE_MOVE);
  });

  it('lists z0-cost-solved.mjs among the analyzer\'s sources', () => {
    expect(sourceRows('scripts/token-eval/z0-analyze.mjs').map((r: { file: string }) => r.file)).toContain('scripts/token-eval/z0-cost-solved.mjs');
  });
});

const BEFORE_THE_MOVE = {"h4":{"costRatio":{"estimate":1.369885082,"iterations":0,"dropped":0,"nullValue":1,"df":18,"low":1.2566013105,"high":1.49338149038,"p":4.5200752043e-7,"se":0.041084889891,"bootstrap":{"estimate":1.369885082,"low":1.29043790339,"high":1.45884673648,"p":0,"iterations":60,"dropped":0,"nullValue":1}},"resolveDiff":{"estimate":-0.166666666667,"iterations":0,"dropped":0,"nullValue":0,"df":8.98336414048,"low":-0.338804449141,"high":0.00547111580766,"p":0.0562228231334,"se":0.0760725774313,"bootstrap":{"estimate":-0.166666666667,"low":-0.25,"high":-0.0416666666667,"p":0,"iterations":60,"dropped":0,"nullValue":0}},"gate":{"pass":false,"costOk":false,"resolveOk":false}},"h3":{"estimate":1.35167072983,"iterations":0,"dropped":0,"nullValue":1,"df":14.5499427009,"low":1.29602041352,"high":1.40971063636,"p":2.23594121216e-10,"se":0.0196719766019,"bootstrap":{"estimate":1.35167072983,"low":1.30515266366,"high":1.40346426335,"p":0,"iterations":60,"dropped":0,"nullValue":1}},"n":324};
