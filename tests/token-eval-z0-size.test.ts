/** Z0 sizing (D6): known-answer power, the false-win rate at a true zero, variance recovery and its bound, and a CLI read of generated records. */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seededRandom } from '../dist/eval/eval-stats.js';
import { chiSquareQuantile, confirmSize, normal, normalCdf, repeatRun, repeatSizer, smallestPassing, varianceComponents } from '../scripts/token-eval/z0-size-sim.mjs';
import { runCli } from '../scripts/token-eval/z0-size.mjs';
import { PRICES, generate, jsonl } from './fixtures/z0-gen.js';

// Each case runs a few thousand bootstraps, several seconds on a loaded box.
vi.setConfig({ testTimeout: 30_000 });

const Z_HOLM = 2.39398;
const Z_95 = 1.959964;
const spread = (repo: number, family: number, seed: number) => ({ scale: 1, loss: 0, repo, family, seed });
const both = (s: ReturnType<typeof spread>) => ({ violation: s, excluded: s });

type Unit = { repo: string; family: string; value: number };
function nested(rand: () => number, repos: number, families: number, seeds: number, [a, b, e]: readonly number[]): Unit[] {
  const units: Unit[] = [];
  for (let r = 0; r < repos; r++) {
    const zr = Math.sqrt(a!) * normal(rand);
    for (let f = 0; f < families; f++) {
      const zf = Math.sqrt(b!) * normal(rand);
      for (let s = 0; s < seeds; s++) units.push({ repo: `r${r}`, family: `r${r}f${f}`, value: 0.3 + zr + zf + Math.sqrt(e!) * normal(rand) });
    }
  }
  return units;
}

describe('Z0 sizing', () => {
  it('matches the closed-form power when only the seed spread is non-zero', () => {
    const [repos, families, sigma, m] = [20, 5, 0.5, 0.1];
    const se = sigma / Math.sqrt(repos * families * 3);
    // With no repository or family spread, the two-level bootstrap's variance is c times the mean's.
    const c = (repos - 1) / repos + (families - 1) / families;
    const seBoot = se * Math.sqrt(c);
    const win = normalCdf(m / se - Z_HOLM * Math.sqrt(c));
    const tie = 2 * normalCdf(Math.min(m - Z_95 * seBoot, Z_HOLM * seBoot) / se) - 1;
    expect(win).toBeCloseTo(0.617, 3);
    expect(tie).toBeCloseTo(0.616, 3);
    const power = repeatSizer(both(spread(0, 0, sigma ** 2)), { sims: 300, iterations: 800, seed: 7 }, 'T1')({ repos, families }, m);
    // 300 runs give a standard error near 0.03, and the bootstrap's own noisy SE lifts the tie share by about 0.03.
    expect(Math.abs(power.win - win)).toBeLessThan(0.07);
    expect(Math.abs(power.tie - tie)).toBeLessThan(0.07);
  });

  it('keeps the false-win rate at a true zero within the Holm level across a small grid', () => {
    const grid = [
      { design: { repos: 5, families: 2 }, cal: both(spread(0.005, 0.02, 0.15)) },
      { design: { repos: 20, families: 1 }, cal: both(spread(0, 0, 0.25)) },
    ];
    for (const { design, cal } of grid) {
      const { falseWin } = repeatSizer(cal, { sims: 1000, iterations: 500, seed: 3 }, 'T2')(design, 0.15);
      expect(falseWin).toBeLessThanOrEqual(0.05 / 3 + 0.01);
    }
  });

  it('recovers nested variance components, and its repository bound covers at the stated level', () => {
    const rand = seededRandom(11);
    const big = varianceComponents(nested(rand, 1000, 4, 3, [0.04, 0.02, 0.09]), 0.8)!;
    expect(Math.abs(big.repo - 0.04)).toBeLessThan(0.008);
    expect(Math.abs(big.family - 0.02)).toBeLessThan(0.006);
    expect(Math.abs(big.seed - 0.09)).toBeLessThan(0.006);
    expect(chiSquareQuantile(0.2, 2)).toBeCloseTo(-2 * Math.log(0.8), 6);
    expect(chiSquareQuantile(0.2, 4)).toBeCloseTo(1.64878, 4);
    expect(chiSquareQuantile(0.95, 1)).toBeCloseTo(3.84146, 4);
    let covered = 0;
    for (let i = 0; i < 2000; i++) if (varianceComponents(nested(rand, 5, 1, 1, [0.04, 0, 0]), 0.8)!.repoUpper >= 0.04) covered++;
    expect(Math.abs(covered / 2000 - 0.8)).toBeLessThan(0.03);
    expect(varianceComponents(nested(rand, 1, 3, 2, [0.04, 0.02, 0.09]), 0.8)).toBeNull();
  });

  it('dilutes the violation coding by its applicable share and drops a coding\'s lost units', () => {
    const flat = { repo: 0, family: 0, seed: 0 };
    const run = repeatRun({ violation: { ...flat, scale: 0.5, loss: 0 }, excluded: { ...flat, scale: 1, loss: 1 } }, { repos: 2, families: 3 }, -0.2, seededRandom(5));
    expect(run.violation.map((u: { value: number }) => u.value)).toEqual(Array(18).fill(-0.1));
    expect(run.excluded).toEqual([]);
  });

  it('finds the smallest passing size by search, and the confirm step corrects a coarse start either way', () => {
    const passes = (x: number) => x >= 7;
    expect(smallestPassing((n) => n, passes, 12)).toEqual({ n: 7, result: 7 });
    expect(smallestPassing((n) => n, passes, 6)).toEqual({ n: null, result: 6 });
    for (const start of [3, 7, 10, null]) expect(confirmSize((n) => n, passes, 12, start)).toEqual({ n: 7, result: 7 });
    expect(confirmSize((n) => n, passes, 6, 3)).toEqual({ n: null, result: 6 });
  });

  it('reads generated calibration records end to end and prices sessions and days per tool', () => {
    const g = generate({ knobs: { A1: { fail: 0, resolve: 1 }, A2: { fail: 0, resolve: 1 }, X2: { fail: 0 }, X3: { fail: 0 } } });
    // The run folder's teardown removes this folder (vitest.config.ts).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-size-'));
    const prices = { ...PRICES, codex: { inputPerMTok: 1.25, cacheWritePerMTok: 0, cacheReadPerMTok: 0.125, outputPerMTok: 10 } };
    const files = { 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(prices) };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    const argv = ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20', '--iterations', '200', '--repos', '5,8', '--claude-usd-per-day', '250', '--out', 'size.json'];
    const res = runCli(argv, dir);
    expect(res).toMatchObject({ code: 0, stderr: '' });
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'size.json'), 'utf8'));
    expect(report.schema).toBe('z0-size/1');
    expect(report.settings.quota).toEqual({ 'claude-code': { usdPerDay: 250, source: 'flag' }, codex: { usdPerDay: 100, source: 'default assumption' } });
    expect(report.calibration.perRecord['A1/teach'].sessions).toBe(2);
    expect(report.calibration.perRecord['A1/apply'].sessions).toBe(1);
    expect(report.calibration.H1.naRate).toBe(0);
    expect(report.unavailable).toEqual([]);
    expect(report.effects.map((e: { minimumEffect: number }) => e.minimumEffect)).toEqual([0.15, 0.2, 0.25]);
    for (const { chosen } of report.effects) {
      // No spread in these records, so one family per repository passes and the fewest repositories win.
      expect(chosen).toMatchObject({ repos: 5, fits: true, setR: { families: 5 }, setX: { families: 5 }, H1: { familiesPerRepo: 1 } });
      expect(chosen.sessions).toBeGreaterThan(0);
      for (const tool of ['claude-code', 'codex']) {
        expect(chosen.usd[tool]).toBeGreaterThan(0);
        expect(chosen.days[tool]).toBeCloseTo(chosen.usd[tool] / report.settings.quota[tool].usdPerDay, 10);
      }
    }
    expect(res.stdout).toMatch(/^minimum effect 15 points: 5 repositories, set R 5 families/);
  });
});
