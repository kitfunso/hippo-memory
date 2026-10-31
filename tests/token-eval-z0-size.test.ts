/** Z0 sizing (D6): known-answer power, the false-win rate at a true zero, spread recovery and its bound, the seed rule, the level check, and a CLI read of generated records. */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seededRandom, verdict } from '../dist/eval/eval-stats.js';
import { fixedRepositoryT, lnGamma } from '../dist/eval/repository-t.js';
import { SPECS } from '../scripts/token-eval/z0-hypotheses.mjs';
import {
  chiSquareQuantile, clopperPearsonUpper, confirmSize, harmRun, levelCheck, normal, repeatRun, repeatSizer,
  seedsNeeded, smallestPassing, spreadComponents, strictest,
} from '../scripts/token-eval/z0-size-sim.mjs';
import { parseArgs, runCli } from '../scripts/token-eval/z0-size.mjs';
import { CELLS, skewCell } from '../scripts/token-eval/z0-skew-check.mjs';
import { PRICES, generate, jsonl } from './fixtures/z0-gen.js';

// Each case simulates thousands of runs; a shared CI runner can be several times slower than a laptop.
vi.setConfig({ testTimeout: 180_000 });

const spread = (family: number, sequence: number, noise: number) => ({ scale: 1, loss: 0, family, sequence, noise });
const both = (s: ReturnType<typeof spread>) => ({ violation: s, excluded: s });

type Unit = { repo: string; family: string; seed: number; value: number };
/** Draws written apart from the sizer: y = delta + a_f + b_s + e inside each repository, b_s shared by its families. */
function reference(rand: () => number, repos: number, families: number, seeds: number, [fam, seq, noise]: readonly number[], delta = 0): Unit[] {
  const units: Unit[] = [];
  for (let r = 0; r < repos; r++) {
    const a = Array.from({ length: families }, () => Math.sqrt(fam!) * normal(rand));
    const b = Array.from({ length: seeds }, () => Math.sqrt(seq!) * normal(rand));
    for (let f = 0; f < families; f++) {
      for (let s = 0; s < seeds; s++) units.push({ repo: `r${r}`, family: `r${r}f${f}`, seed: s + 1, value: delta + a[f]! + b[s]! + Math.sqrt(noise!) * normal(rand) });
    }
  }
  return units;
}

describe('Z0 sizing', () => {
  it('matches an independent simulation of the same model through the analyzer\'s t test and verdict rule', () => {
    const [repos, families, m, sims] = [6, 3, 0.15, 1500];
    const spreads = [0.02, 0.03, 0.09] as const;
    const tieBand: [number, number] = [-m, m];
    const spec = { ...SPECS.H1, tieBand, minimumEffectAt: -m };
    const verdictShares = (delta: number, name: string) => {
      const rand = seededRandom(97);
      let hits = 0;
      for (let i = 0; i < sims; i++) {
        const est = fixedRepositoryT(reference(rand, repos, families, 3, spreads, delta), 0);
        if (verdict(est, strictest(est.p), spec).verdict === name) hits++;
      }
      return hits / sims;
    };
    const power = repeatSizer(both(spread(...spreads)), { sims, seed: 7, rule: false }, 'T1')({ repos, families }, m);
    // Each share is near 0.4 to 0.5, so 1500 runs give a standard error near 0.013 and the gap of two shares near 0.018.
    expect(Math.abs(power.win - verdictShares(-m, 'win'))).toBeLessThan(0.07);
    expect(Math.abs(power.tie - verdictShares(0, 'tie'))).toBeLessThan(0.07);
    expect(power.win).toBeGreaterThan(0.2);
    expect(power).toMatchObject({ meanSeeds: 3, stopShare: 0 });
  });

  it('gives a flat table a sure win at the effect and a sure tie at zero, and the rule keeps it at 3 seeds', () => {
    const flat = both(spread(0, 0, 0));
    expect(repeatSizer(flat, { sims: 20, seed: 1 }, 'T0')({ repos: 3, families: 2 }, 0.15)).toEqual({ win: 1, tie: 1, falseWin: 0, meanSeeds: 3, stopShare: 0 });
  });

  it('keeps the false-win rate at a true zero within the Holm level across a small grid', () => {
    const grid = [
      { design: { repos: 5, families: 2 }, cal: both(spread(0.02, 0.01, 0.15)) },
      { design: { repos: 20, families: 2 }, cal: both(spread(0, 0, 0.25)) },
    ];
    for (const { design, cal } of grid) {
      const { falseWin } = repeatSizer(cal, { sims: 1000, seed: 3, rule: false }, 'T2')(design, 0.15);
      expect(falseWin).toBeLessThanOrEqual(0.05 / 2 + 0.01);
    }
  });

  it('holds the H4 cost gate to its two-sided 2.5% at a true ratio of 1.10 when repository costs are near normal', () => {
    // Skewed cells sit between 2.5% and the prereg's 5% (z0-skew-check.mjs, analyzer doc); this one shows the interval is sound.
    const near = CELLS.find((c: { name: string }) => c.name === 'near normal')!;
    const s = skewCell(near, 4_000, 1);
    expect(s.costLog).toBeLessThanOrEqual(0.025 + 2 * Math.sqrt((0.025 * 0.975) / 4_000));
    expect(s.gateLog).toBeLessThanOrEqual(s.costLog);
    expect(CELLS.map((c: { name: string; repos: number }) => `${c.name} ${c.repos}`)).toEqual([
      'calibration-like 5', 'harsher 5', 'sequence-heavy 5', 'calibration-like 10', 'harsher 10', 'sequence-heavy 10', 'near normal 5',
    ]);
  });

  it('recovers the family, sequence and noise spreads, and the noise bound covers at the stated level', () => {
    const rand = seededRandom(11);
    const big = spreadComponents(reference(rand, 400, 4, 4, [0.02, 0.03, 0.09]), 0.8)!;
    expect(Math.abs(big.family - 0.02)).toBeLessThan(0.006);
    expect(Math.abs(big.sequence - 0.03)).toBeLessThan(0.006);
    expect(Math.abs(big.noise - 0.09)).toBeLessThan(0.006);
    expect([big.repos, big.families, big.units, big.sBar, big.kBar]).toEqual([400, 1600, 6400, 4, 4]);
    expect(big.df).toEqual({ family: 1200, sequence: 1200, noise: 3600 });
    for (const k of ['family', 'sequence', 'noise'] as const) expect(big.upper[k]).toBeGreaterThan(big[k]);
    expect(chiSquareQuantile(0.2, 2)).toBeCloseTo(-2 * Math.log(0.8), 6);
    expect(chiSquareQuantile(0.2, 4)).toBeCloseTo(1.64878, 4);
    expect(chiSquareQuantile(0.95, 1)).toBeCloseTo(3.84146, 4);
    let covered = 0;
    for (let i = 0; i < 2000; i++) if (spreadComponents(reference(rand, 3, 3, 3, [0.02, 0.03, 0.09]), 0.8)!.upper.noise >= 0.09) covered++;
    expect(Math.abs(covered / 2000 - 0.8)).toBeLessThan(0.03);
    expect(spreadComponents(reference(rand, 1, 1, 3, [0.02, 0.03, 0.09]), 0.8)).toBeNull();
    expect(spreadComponents(reference(rand, 1, 3, 2, [0.02, 0.03, 0.09]), 0.8)).toMatchObject({ repos: 1, families: 3, units: 6 });
  });

  it('finds the exact one-sided upper bound of a binomial share', () => {
    expect(clopperPearsonUpper(0, 22, 0.8)).toBeCloseTo(1 - 0.2 ** (1 / 22), 9);
    expect(clopperPearsonUpper(22, 22, 0.8)).toBe(1);
    const p = clopperPearsonUpper(5, 20, 0.8);
    // P(X <= 5 | 20, p) by the plain binomial sum: exp(lnGamma) keeps the coefficients exact enough.
    const cdf = Array.from({ length: 6 }, (_, i) => Math.exp(lnGamma(21) - lnGamma(i + 1) - lnGamma(21 - i) + i * Math.log(p) + (20 - i) * Math.log(1 - p))).reduce((a, b) => a + b, 0);
    expect(cdf).toBeCloseTo(0.2, 6);
  });

  it('sizes seeds from first-wave mean squares: 3 when noise is tiny, none when the family term alone is too big, more for more noise', () => {
    const m = 0.3;
    const at = (noise: number, family = 0.01, stream = 5) => seedsNeeded(reference(seededRandom(stream), 6, 4, 3, [family, 0.01, noise]), m);
    expect(at(1e-6)).toBe(3);
    // The family term alone leaves family / k / G = 0.17 / 24 of variance, above the (0.3 / 3.5)^2 target.
    expect(at(0.01, 1)).toBeNull();
    for (const stream of [1, 2, 3, 4, 5]) {
      const needs = [0.01, 0.5, 2].map((noise) => at(noise, 0.01, stream) ?? Infinity);
      expect(needs).toEqual([...needs].sort((a, b) => a - b));
      expect(needs[0]).toBe(3);
      expect(needs[2]).toBeGreaterThan(3);
    }
    const units = reference(seededRandom(8), 6, 4, 3, [0.01, 0.01, 0.5]);
    const loose = seedsNeeded(units, m)!;
    expect(seedsNeeded(units, m, { cap: loose - 1 })).toBeNull();
    expect(seedsNeeded(units, m, { targetZ: 1 })).toBe(3);
    expect(seedsNeeded([], m)).toBeNull();
  });

  it('dilutes the violation coding by its applicable share and drops a coding\'s lost units', () => {
    const flat = { family: 0, sequence: 0, noise: 0 };
    const cal = { violation: { ...flat, scale: 0.5, loss: 0 }, excluded: { ...flat, scale: 1, loss: 1 } };
    const run = repeatRun(cal, { repos: 2, families: 3, seeds: 3 }, -0.2, seededRandom(5));
    expect(run.units.violation.map((u: { value: number }) => u.value)).toEqual(Array(18).fill(-0.1));
    expect(run.units.excluded).toEqual([]);
    expect([run.seeds, run.stopped]).toEqual([3, false]);
  });

  it('shares each sequence effect across a repository\'s families and each family effect across its seeds', () => {
    const only = (family: number, sequence: number) => both({ scale: 1, loss: 0, family, sequence, noise: 0 });
    const [byFamily, bySeed] = [only(0.2, 0), only(0, 0.2)].map((cal) => repeatRun(cal, { repos: 2, families: 3, seeds: 4 }, 0, seededRandom(2)).units.violation);
    const cells = (units: Unit[], key: 'family' | 'seed') => [...new Set(units.map((u) => u[key]))].map((k) => units.filter((u) => u[key] === k).map((u) => u.value));
    for (const values of cells(byFamily!, 'family')) expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1e-12);
    for (const r of ['r0', 'r1']) {
      for (const values of cells(bySeed!.filter((u: Unit) => u.repo === r), 'seed')) expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1e-12);
    }
    expect(new Set(bySeed!.filter((u: Unit) => u.repo === 'r0').map((u: Unit) => u.seed)).size).toBe(4);
  });

  it('draws 3 to 9 seeds under the rule and extends the same families, or stops after wave 1', () => {
    const cal = both(spread(0.005, 0.005, 0.05));
    const design = { repos: 6, families: 3, seeds: 3 };
    const seen = new Set<number>();
    for (let i = 1; i <= 12; i++) {
      const run = repeatRun(cal, design, -0.15, seededRandom(i), { m: 0.15, cap: 9, targetZ: 3.5 });
      expect(run.stopped).toBe(false);
      expect(run.seeds).toBeGreaterThanOrEqual(3);
      expect(run.seeds).toBeLessThanOrEqual(9);
      seen.add(run.seeds);
      // The same stream drawn straight to that many seeds is identical: later seeds add to the wave-1 families.
      expect(repeatRun(cal, { ...design, seeds: run.seeds }, -0.15, seededRandom(i)).units).toEqual(run.units);
      const families = new Set(run.units.violation.filter((u: Unit) => u.seed === 1).map((u: Unit) => u.family));
      for (let s = 2; s <= run.seeds; s++) expect(new Set(run.units.violation.filter((u: Unit) => u.seed === s).map((u: Unit) => u.family))).toEqual(families);
    }
    expect(seen.size).toBeGreaterThan(1);
    const stopped = repeatRun(both(spread(1, 0, 0.01)), design, -0.15, seededRandom(1), { m: 0.15, cap: 9, targetZ: 3.5 });
    expect([stopped.stopped, stopped.seeds]).toEqual([true, 3]);
    const power = repeatSizer(both(spread(1, 0, 0.01)), { sims: 30, seed: 2 }, 'T3')({ repos: 6, families: 3 }, 0.15);
    expect(power).toMatchObject({ win: 0, tie: 0, falseWin: 0, meanSeeds: 3, stopShare: 1 });
  });

  it('simulates set N with one unit per task and seed, and no summed n', () => {
    const rand = seededRandom(4);
    const cal = { family: 0, sequence: 0, noise: 0, controlSd: 0, both: 0.5, oneSide: 0.1 };
    const units = harmRun(cal, { repos: 2, tasks: 3, seeds: 4 }, rand, 1.1);
    expect(units).toHaveLength(24);
    expect([...new Set(units.map((u: { seed: number }) => u.seed))]).toEqual([1, 2, 3, 4]);
    expect(units.some((u: { seed: number }) => 'n' in u)).toBe(false);
    expect(units[0]).toMatchObject({ repo: 'r0', family: 'r0n0', seed: 1 });
    for (const u of units) expect(u.t.cost / u.c.cost).toBeCloseTo(1.1, 12);
    expect(harmRun(cal, { repos: 1, tasks: 1 }, rand)).toHaveLength(3);
    const ratios = (c: { family?: number; sequence?: number }) => harmRun({ ...cal, ...c }, { repos: 1, tasks: 3, seeds: 3 }, seededRandom(6)).map((u: { t: { cost: number }; c: { cost: number } }) => Math.log(u.t.cost / u.c.cost));
    // Only the sequence varies: one value per seed, shared by every task. Only the family varies: one per task, shared by every seed.
    const seq = ratios({ sequence: 0.2 });
    for (let s = 0; s < 3; s++) expect(new Set([0, 1, 2].map((k) => seq[k * 3 + s]!.toFixed(10))).size).toBe(1);
    expect(new Set(seq.map((x: number) => x.toFixed(10))).size).toBe(3);
    const fam = ratios({ family: 0.2 });
    for (let k = 0; k < 3; k++) expect(new Set([0, 1, 2].map((s) => fam[k * 3 + s]!.toFixed(10))).size).toBe(1);
  });

  it('checks the level of a test by cell and coding, and holds a flat table at zero', () => {
    const flat = both(spread(0, 0, 0));
    const design = { repos: 4, families: 3 };
    const flatLevel = levelCheck(flat, flat, design, 0.2, { sims: 30, seed: 1 });
    expect(flatLevel.cells.map((c) => `${c.name}/${c.coding}`)).toEqual(
      ['rule at bounds', 'three seeds', 'two seeds at bounds', '0/1 values'].flatMap((n) => ['violation', 'excluded'].map((c) => `${n}/${c}`)));
    expect(flatLevel.cells[2]!.ceiling).toBeCloseTo(0.025 + 2 * Math.sqrt((0.025 * 0.975) / 30), 12);
    for (const c of flatLevel.cells.slice(0, 6)) expect([c.level, c.runs]).toEqual([0, 30]);
    const noisy = both(spread(0.02, 0.02, 0.1));
    const level = levelCheck(noisy, noisy, design, 0.2, { sims: 60, seed: 2 });
    expect([true, false]).toContain(level.held);
    for (const c of level.cells) expect(c.level).toBeGreaterThanOrEqual(0);
    // A rule that always stops leaves no run to read, which cannot pass as held.
    const stopping = both(spread(1, 0, 0.01));
    const none = levelCheck(stopping, stopping, { repos: 6, families: 3 }, 0.15, { sims: 10, seed: 1 });
    expect(none.cells[0]).toMatchObject({ name: 'rule at bounds', runs: 0 });
    expect([Number.isNaN(none.cells[0].level), none.held]).toEqual([true, false]);
    // A rule that stops some runs is judged on the runs it let go, so its bar is wider than the fixed-seed cells'.
    const some = levelCheck(both(spread(0.05, 0, 0.05)), both(spread(0.05, 0, 0.05)), { repos: 6, families: 3 }, 0.15, { sims: 40, seed: 1 });
    const [ruled, fixed] = [some.cells[0]!, some.cells[2]!];
    expect(ruled.runs > 0 && ruled.runs < 40).toBe(true);
    expect([ruled.stopShare, fixed.runs, fixed.stopShare]).toEqual([1 - ruled.runs / 40, 40, 0]);
    expect(ruled.ceiling).toBeCloseTo(0.025 + 2 * Math.sqrt((0.025 * 0.975) / ruled.runs), 12);
    expect(fixed.ceiling).toBeCloseTo(0.025 + 2 * Math.sqrt((0.025 * 0.975) / 40), 12);
  });

  it('finds the smallest passing size by search, and the confirm step corrects a coarse start either way', () => {
    const passes = (x: number) => x >= 7;
    expect(smallestPassing((n) => n, passes, 12)).toEqual({ n: 7, result: 7 });
    expect(smallestPassing((n) => n, passes, 6)).toEqual({ n: null, result: 6 });
    for (const start of [3, 7, 10, null]) expect(confirmSize((n) => n, passes, 12, start)).toEqual({ n: 7, result: 7 });
    expect(confirmSize((n) => n, passes, 6, 3)).toEqual({ n: null, result: 6 });
  });

  it('reads --spread-bound and the seed flags, and no longer knows --repo-bound', () => {
    const base = ['--runs', 'r.jsonl', '--plan', 'p.json', '--prices', 'c.json'];
    expect(parseArgs([...base, '--spread-bound', '0.7', '--seed-cap', '6', '--target-z', '3', '--max-families-per-repo', '3', '--level-sims', '50'])).toMatchObject({
      spreadBound: 0.7, seedCap: 6, targetZ: 3, maxFamiliesPerRepo: 3, levelSims: 50,
    });
    expect(parseArgs(base)).toMatchObject({ spreadBound: 0.8, seedCap: 9, targetZ: 3.5, maxFamiliesPerRepo: 4, levelSims: 20_000, repos: [5, 8, 10, 12, 15, 20] });
    expect(runCli([...base, '--repo-bound', '0.8'])).toMatchObject({ code: 1, stderr: expect.stringContaining('unknown flag --repo-bound') });
    for (const bad of [['--seed-cap', '2'], ['--max-families-per-repo', '1'], ['--target-z', '0'], ['--level-sims', '0'], ['--spread-bound', '1']]) {
      expect(() => parseArgs([...base, ...bad])).toThrow(bad[0]!);
    }
  });

  it('reads generated calibration records end to end and prices sessions and days per tool', () => {
    const g = generate({ knobs: { A1: { fail: 0, resolve: 1 }, A2: { fail: 0, resolve: 1 }, X2: { fail: 0 }, X3: { fail: 0 } } });
    // The run folder's teardown removes this folder (vitest.config.ts).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-size-'));
    const prices = { ...PRICES, codex: { inputPerMTok: 1.25, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125, outputPerMTok: 10 } };
    const files = { 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(prices) };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    const argv = ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20', '--repos', '5,8', '--level-sims', '20', '--claude-usd-per-day', '250', '--out', 'size.json'];
    const res = runCli(argv, dir);
    expect(res).toMatchObject({ code: 0, stderr: '' });
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'size.json'), 'utf8'));
    expect(report.schema).toBe('z0-size/1');
    expect(report.settings).toMatchObject({ firstWave: 3, seedCap: 9, targetZ: 3.5, spreadBound: 0.8, levelSims: 20, holmLevel: 0.025 });
    expect(report.settings.quota).toEqual({ 'claude-code': { usdPerDay: 250, source: 'flag' }, codex: { usdPerDay: 100, source: 'default assumption' } });
    expect(report.calibration.perRecord['A1/teach'].sessions).toBe(2);
    expect(report.calibration.perRecord['A1/apply'].sessions).toBe(1);
    expect(report.calibration.H1.naRate).toBe(0);
    expect(report.calibration.H1.sim).toBeUndefined();
    expect(report.calibration.H4.resolve).toMatchObject({ pairs: expect.any(Number), discordant: 0, both: 1, oneSideEstimate: 0 });
    expect(report.calibration.H4.resolve.oneSide).toBeGreaterThan(0);
    expect(report.unavailable).toEqual([]);
    expect(report.effects.map((e: { minimumEffect: number }) => e.minimumEffect)).toEqual([0.15, 0.2, 0.25]);
    for (const { chosen, level } of report.effects) {
      // No spread in these records, so two families per repository pass (one gives the rule nothing to fit) and the fewest repositories win.
      expect(chosen).toMatchObject({ repos: 5, fits: true, boundsPass: true, setR: { families: 10 }, setX: { families: 10 }, H1: { familiesPerRepo: 2 } });
      expect(chosen.H1.power).toMatchObject({ meanSeeds: 3, stopShare: 0 });
      expect(chosen.H1.boundsPower).toMatchObject({ win: 1, tie: 1, meanSeeds: 3, stopShare: 0 });
      expect(chosen.sessions).toBeGreaterThan(0);
      expect(chosen.usageAtCap.sessions).toBeGreaterThan(chosen.sessions);
      for (const tool of ['claude-code', 'codex']) {
        expect(chosen.usd[tool]).toBeGreaterThan(0);
        expect(chosen.usageAtCap.usd[tool]).toBeGreaterThan(chosen.usd[tool]);
        expect(chosen.days[tool]).toBeCloseTo(chosen.usd[tool] / report.settings.quota[tool].usdPerDay, 10);
        expect(chosen.daysAtCap[tool]).toBeCloseTo(chosen.usageAtCap.usd[tool] / report.settings.quota[tool].usdPerDay, 10);
      }
      expect(level.H1.cells).toHaveLength(8);
      expect(level.H2.cells).toHaveLength(8);
      expect([true, false]).toContain(level.held);
    }
    expect(res.stdout).toMatch(/^minimum effect 15 points: 5 repositories, set R 10 families.*H1 mean seeds 3\.0, level (held|FAILED)/);
  });
});
