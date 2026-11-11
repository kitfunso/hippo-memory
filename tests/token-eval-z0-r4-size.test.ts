// Round 4 prereg items 3, 10 and 12: the sizer, the seed rule, the Level check, the power read and --check-levels, on generated batches and hand-made tables.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { seededRandom } from '../dist/eval/eval-stats.js';
import { ARM_TABLE, DESIGNS } from '../scripts/token-eval/arms.mjs';
import { sourceRows } from '../scripts/token-eval/z0-blind.mjs';
import { filterOpts } from '../scripts/token-eval/z0-filters.mjs';
import { LEVELS_SCHEMA, SEED_PREVIEW_SCHEMA, parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { runCli as seedRuleCli, seedRule } from '../scripts/token-eval/z0-seed-rule.mjs';
import { R4_SEED, levelCheckR4, powerStop, prepareR4, testSeeds } from '../scripts/token-eval/z0-size-r4.mjs';
import { binaryRun, levelCells, predictedSe, repeatRun, seedsNeeded } from '../scripts/token-eval/z0-size-sim.mjs';
import { runCli as sizeCli } from '../scripts/token-eval/z0-size.mjs';
import { THRESHOLDS, minLevels } from '../scripts/token-eval/z0-verdict-r4.mjs';
import { PRICES, PRICES_BY_MODEL, generate, jsonl, planOf, type Z0Record } from './fixtures/z0-gen.js';

// Each `it` runs 20 to 50 draws per case; a shared runner can be slow, so the limit is a minute.
vi.setConfig({ testTimeout: 60_000 });

type Unit = { repo: string; family: string; seed: number; value: number };
const R3_ARMS = [...DESIGNS['r4-on-r3'].arms];
const parse = (recs: readonly Z0Record[]) => parseZ0Records(jsonl(recs), 'runs.jsonl').records;
const dirWith = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-r4-size-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const STRIPPED = ['design', 'wholePlan', 'preLevels', 'costRatio', 'spendBasis'];
const withoutInputs = (text: string, keys: string[]) => {
  const json = JSON.parse(text);
  delete json.inputs;
  for (const k of keys) delete json.settings[k];
  return JSON.stringify(json);
};
const lineOf = (stdout: string, re: RegExp) => stdout.split('\n').find((l) => re.test(l)) ?? '';

describe('[S5A-R1] a layout and a calibration the engine cannot draw from', () => {
  const cal = { violation: { scale: 1, loss: 0, family: 0.02, sequence: 0.01, noise: 0.1 }, excluded: { scale: 1, loss: 0, family: 0.02, sequence: 0.01, noise: 0.1 } };

  it('stops repeatRun and binaryRun on a design with neither a layout nor a positive integer repos and families', () => {
    expect(() => repeatRun(cal, { seeds: 3 }, 0, seededRandom(1))).toThrow('repeatRun: design needs a layout or a positive integer repos and families, got {"seeds":3}');
    expect(() => binaryRun(cal, { seeds: 3 }, seededRandom(1))).toThrow('repeatRun: design needs a layout or a positive integer repos and families, got {"seeds":3}');
    for (const design of [{ repos: 0, families: 3, seeds: 3 }, { repos: 2.5, families: 3, seeds: 3 }, { repos: 2, seeds: 3 }, { families: 2, seeds: 3 }]) {
      expect(() => repeatRun(cal, design, 0, seededRandom(1)), JSON.stringify(design)).toThrow(/needs a layout or a positive integer repos and families/);
    }
    expect(repeatRun(cal, { repos: 2, families: 3, seeds: 3 }, 0, seededRandom(1)).units.violation).toHaveLength(18);
  });

  const spec = (extra: Partial<Record<'calPoint' | 'calUpper', Record<string, Record<string, number | undefined>>>>) => ({
    test: 'T2a', calPoint: cal, calUpper: cal, layout: [{ repo: 'a', k: 3 }, { repo: 'b', k: 3 }], rule: { m: 0.105, targetZ: 3.08, cap: 9, near: 1.1 },
    sims: 5, seed: 1, label: 'unit', cases: ['rule at point'], ...extra,
  });
  const NAMED = /^levelCells T2a: spec\.(calPoint|calUpper) needs a calibration under both coding keys \(violation, excluded\) with finite scale, loss, family, sequence and noise; a one-coding test passes one calibration under both keys$/;

  it('names the calibration a one-coding test lacks, a missing key or a NaN field, before any draw', () => {
    expect(() => levelCells(spec({ calPoint: { violation: cal.violation } }))).toThrow(NAMED);
    expect(() => levelCells(spec({ calUpper: { excluded: cal.excluded } }))).toThrow(NAMED);
    const nan = { ...cal, excluded: { ...cal.excluded, noise: Number.NaN } };
    expect(() => levelCells(spec({ calPoint: nan }))).toThrow(NAMED);
    expect(() => levelCells(spec({ calUpper: { ...cal, violation: { ...cal.violation, family: undefined } } }))).toThrow(NAMED);
    expect(levelCells(spec({}))).toHaveLength(1);
  });
});

describe('the round 4 sizer on a generated round 3 batch', () => {
  const DESIGN = DESIGNS['r4-on-r3'];
  const g = generate({ arms: R3_ARMS });
  const prepared = () => prepareR4(parse(g.records), g.plan, PRICES_BY_MODEL, { ...filterOpts({ design: DESIGN }), spreadBound: 0.8 });
  const planted = (bad: (test: string, setting: string, sims: number) => number[] | null, calls: { test: string; sims: number; cases?: string[]; label?: string }[] = []) => (spec: any) => {
    calls.push({ test: spec.test, sims: spec.sims, cases: spec.cases, label: spec.label });
    // The real case names, from a 2-draw run, with the planted p values in place of the draws.
    return levelCells({ ...spec, sims: 2 }).map((c: { setting: string }) => ({ setting: c.setting, ps: bad(spec.test, c.setting, spec.sims) ?? Array.from({ length: spec.sims }, () => 1), noEstimate: 0 }));
  };
  const OPTS = { levelSims: 20, source: 'pre-freeze', commit: null, inputs: [] };

  it('writes a levels file whose setBy is a setting that minLevels finds, with the sizes at the level', () => {
    // 30% of one cell's p values sit at 0.0415, so L is 0.041 and the cell is 0.300 at L + 0.001 and 0.000 at L.
    const at = (test: string, setting: string, sims: number) => (test === 'T1' && setting === 'rule at point (violation)' ? Array.from({ length: sims }, (_, i) => (i < 0.3 * sims ? 0.0415 : 1)) : null);
    const { file, lines, code } = levelCheckR4(prepared(), OPTS, planted(at));
    expect(code).toBe(0);
    expect([file.schema, file.source, file.draws, file.floorFlags]).toEqual([LEVELS_SCHEMA, 'pre-freeze', 20, []]);
    expect(file.sources).toEqual(sourceRows('scripts/token-eval/z0-size.mjs'));
    expect(Object.keys(file.levels).sort()).toEqual(Object.keys(THRESHOLDS).sort());
    for (const [test, thresholds] of Object.entries(THRESHOLDS)) {
      expect(Object.keys(file.levels[test]).sort(), test).toEqual([...thresholds].sort());
      for (const t of thresholds) {
        const e = file.levels[test][t];
        expect(e.setBy, `${test} ${t}`).toEqual(expect.any(String));
        expect(e.cells.some((c: { setting: string }) => c.setting === e.setBy), `${test} ${t}`).toBe(true);
        expect(e.largestAtLevel).toBe(Math.max(...e.cells.map((c: { size: number }) => c.size)));
        expect(Number.isFinite(e.sizeAtLevel) && Number.isFinite(e.simErrorAtLevel)).toBe(true);
      }
    }
    const t1 = file.levels.T1['0.05'];
    expect([t1.level, t1.setBy, t1.sizeAtLevel]).toEqual([0.041, 'rule at point (violation)', 0]);
    const pair = minLevels(file, { ...file, source: 'batch-1' }, () => {});
    expect(pair.T1['0.05'].cell).not.toBeNull();
    const printed = lineOf(lines.join('\n'), /^T1 0\.05:/);
    expect(printed).toMatch(/size at level 0\.000/);
    expect(printed).toMatch(/largest at level 0\.000/);
    expect(lines.join('\n')).not.toMatch(/0\.300/);
  });

  it('adds part (a)\'s rule cells on the T2aMiss pair to T2a under r4-on-r3, with their own label and settings', () => {
    const calls: { test: string; sims: number; cases?: string[]; label?: string }[] = [];
    const { file } = levelCheckR4(prepared(), OPTS, planted(() => null, calls));
    const t2a = calls.filter((c) => c.test === 'T2a');
    expect(t2a).toHaveLength(2);
    expect(t2a[1]!.cases).toEqual(['rule at point', 'rule at upper']);
    expect(t2a[1]!.label).not.toBe(t2a[0]!.label);
    const settings = file.levels.T2a['0.05'].cells.map((c: { setting: string }) => c.setting);
    expect(new Set(settings).size).toBe(settings.length);
    expect(settings.filter((s: string) => /^rule at (point|upper) \[/.test(s))).toHaveLength(2);
  });

  it('reruns every cell over the threshold at the floor at 5 times the draws, flags a level still under it and exits 3', () => {
    const bad = (test: string, _setting: string, sims: number) => (test === 'T1' ? Array.from({ length: sims }, (_, i) => (i < 0.1 * sims ? 0.002 : 1)) : null);
    const calls: { test: string; sims: number; cases?: string[]; label?: string }[] = [];
    const { file, lines, code } = levelCheckR4(prepared(), OPTS, planted(bad, calls));
    const t1 = calls.filter((c) => c.test === 'T1');
    expect(t1[0]!.sims).toBe(20);
    expect(t1.slice(1).map((c) => c.sims)).toEqual([100]);
    expect(t1[1]!.label).not.toBe(t1[0]!.label);
    expect(file.floorFlags).toEqual([{ test: 'T1', threshold: '0.05', level: 0.002, setBy: expect.any(String), draws: 100 }]);
    expect(lines).toContain('BROKEN DESIGN: T1 0.05');
    expect(code).toBe(3);
  });

  it('writes no flag and exits 0 when no cell sits over the threshold at the floor', () => {
    const { file, lines, code } = levelCheckR4(prepared(), OPTS, planted(() => null));
    expect([file.floorFlags, code, lines.some((l: string) => l.startsWith('BROKEN DESIGN'))]).toEqual([[], 0, false]);
    expect(file.levels.T1['0.05'].level).toBe(0.05);
    expect(file.levels.T3['0.025'].level).toBe(0.025);
  });

  it('does not flag a level equal to the floor, 0.040 against 0.8 times 0.05, and runs no rerun', () => {
    const at = (test: string, setting: string, sims: number) => (test === 'T1' && setting === 'rule at point (violation)' ? Array.from({ length: sims }, (_, i) => (i < 0.3 * sims ? 0.0405 : 1)) : null);
    const calls: { test: string; sims: number }[] = [];
    const { file, code } = levelCheckR4(prepared(), OPTS, planted(at, calls));
    expect(file.levels.T1['0.05'].level).toBeCloseTo(0.04, 9);
    expect([file.floorFlags, code, calls.filter((c) => c.test === 'T1').length]).toEqual([[], 0, 1]);
  });

  it('prints each pre-freeze level, the new one and the lower, for a pre-freeze file read with --pre-levels', () => {
    const pre = levelCheckR4(prepared(), OPTS, planted(() => null)).file;
    const low = { ...pre, levels: { ...pre.levels, T1: { '0.05': { ...pre.levels.T1['0.05'], level: 0.03 } } } };
    const { lines } = levelCheckR4(prepared(), { ...OPTS, source: 'batch-1', pre: low }, planted(() => null));
    expect(lineOf(lines.join('\n'), /^T1 0\.05 levels:/)).toBe('T1 0.05 levels: pre-freeze 0.030, batch-1 0.050, lower 0.030');
  });
});

describe('--check-levels in a scratch copy of the harness', () => {
  const REPO = path.resolve(__dirname, '..');
  const scratch = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-r4-levels-'));
    for (const dir of ['scripts/token-eval', 'scripts/lib']) fs.cpSync(path.join(REPO, dir), path.join(root, dir), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'scripts/z7-sidechain-lib.mjs'), path.join(root, 'scripts/z7-sidechain-lib.mjs'));
    fs.mkdirSync(path.join(root, 'dist/eval'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/eval'), { recursive: true });
    for (const f of ['eval-stats.js', 'repository-t.js']) fs.copyFileSync(path.join(REPO, 'dist/eval', f), path.join(root, 'dist/eval', f));
    for (const f of ['eval-stats.ts', 'repository-t.ts']) fs.copyFileSync(path.join(REPO, 'src/eval', f), path.join(root, 'src/eval', f));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
    return root;
  };
  const g = generate({ arms: R3_ARMS });
  const data = dirWith({ 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES_BY_MODEL) });
  const node = (root: string, argv: string[]) => spawnSync(process.execPath, [path.join(root, 'scripts/token-eval/z0-size.mjs'), ...argv], { cwd: data, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(REPO, 'node_modules') } });

  it('passes the file the same checkout wrote and names an added, changed or missing source otherwise', () => {
    const root = scratch();
    const made = node(root, ['--design', 'r4-on-r3', '--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--level-check', '--level-sims', '20', '--out', 'levels.json']);
    expect([0, 3], made.stderr).toContain(made.status);
    const file = JSON.parse(fs.readFileSync(path.join(data, 'levels.json'), 'utf8'));
    expect(file.floorFlags.length > 0).toBe(made.status === 3);
    const pass = node(root, ['--check-levels', 'levels.json']);
    expect([pass.status, pass.stdout.trim()]).toEqual([0, `CHECK LEVELS PASS: ${file.sources.length} sources`]);
    const tokenEval = path.join(root, 'scripts/token-eval');
    for (const name of ['z0-hypotheses.mjs', 'z0-cost-solved.mjs', 'z0-verdict-r4.mjs']) {
      const before = fs.readFileSync(path.join(tokenEval, name));
      fs.writeFileSync(path.join(tokenEval, name), Buffer.concat([before, Buffer.from('\n')]));
      const fail = node(root, ['--check-levels', 'levels.json']);
      expect([name, fail.status, fail.stdout.trim()]).toEqual([name, 3, `CHECK LEVELS FAIL: levels.json: scripts/token-eval/${name} changed`]);
      fs.writeFileSync(path.join(tokenEval, name), before);
    }
    const sim = path.join(tokenEval, 'z0-size-sim.mjs');
    const text = fs.readFileSync(sim, 'utf8');
    fs.writeFileSync(path.join(tokenEval, 'z0-added.mjs'), 'export const added = 1;\n');
    fs.writeFileSync(sim, `import './z0-added.mjs';\n${text}`);
    const added = node(root, ['--check-levels', 'levels.json']);
    expect(added.status).toBe(3);
    expect(added.stdout).toContain('CHECK LEVELS FAIL: levels.json: scripts/token-eval/z0-added.mjs added');
    expect(added.stdout).toContain('CHECK LEVELS FAIL: levels.json: scripts/token-eval/z0-size-sim.mjs changed');
  });

  it('exits 1, naming the file, for a file that is not a levels file, and needs no other input', () => {
    const root = scratch();
    fs.writeFileSync(path.join(data, 'other.json'), '{"schema":"z0-seed-rule/2"}');
    const bad = node(root, ['--check-levels', 'other.json']);
    expect([bad.status, bad.stderr]).toEqual([1, `other.json: schema is z0-seed-rule/2, not ${LEVELS_SCHEMA}\n`]);
  });
});

describe('the per-test seed rules', () => {
  // A large family part: no seed count brings the error under the bar.
  const heavy: Unit[] = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 4; f++) for (let s = 1; s <= 3; s++) heavy.push({ repo: `r${r}`, family: `r${r}f${f}`, seed: s, value: ((r * 7 + f * 3) % 5 - 2) + 0.01 * ((s * 13 + f) % 3) });

  it('takes the fewest seeds within 1.1 times the 9-seed error when part (a) misses, and names the miss', () => {
    const got = testSeeds('T2a', [heavy], undefined);
    expect(got.branch).toBe('miss');
    expect(got.predictedSE.atCount).toBeLessThanOrEqual(1.1 * got.predictedSE.at9);
    expect(got.predictedSE.at9).toBeCloseTo(predictedSe(heavy, 9)!, 12);
    expect(got.seeds === 3 || predictedSe(heavy, got.seeds - 1)! > 1.1 * got.predictedSE.at9).toBe(true);
    expect(got.seeds).toBeLessThanOrEqual(9);
  });

  it('runs a part (b) miss at the cap, and a part that meets its bar by the rule', () => {
    expect(testSeeds('T2b', [heavy], undefined)).toMatchObject({ seeds: 9, branch: 'cap' });
    const quiet = repeatRun({ violation: { scale: 1, loss: 0, family: 0, sequence: 0, noise: 0.0004 }, excluded: { scale: 1, loss: 0, family: 0, sequence: 0, noise: 0.0004 } }, { repos: 6, families: 4, seeds: 3 }, 0, seededRandom(3)).units.violation;
    expect(testSeeds('T2b', [quiet], undefined)).toMatchObject({ seeds: 3, branch: 'rule' });
  });

  it('gives a repeat test the larger count of its two codings', () => {
    const units = (noise: number, seed: number) => repeatRun({ violation: { scale: 1, loss: 0, family: 0, sequence: 0.01, noise }, excluded: { scale: 1, loss: 0, family: 0, sequence: 0.01, noise } }, { repos: 6, families: 4, seeds: 3 }, 0, seededRandom(seed)).units.violation;
    const [low, high] = [units(0.1, 5), units(0.3, 5)];
    const [a, b] = [seedsNeeded(low, 0.15, { targetZ: 3.5 }), seedsNeeded(high, 0.15, { targetZ: 3.5 })];
    expect([a, b].some((x) => x === null)).toBe(false);
    expect(b).toBeGreaterThan(a!);
    for (const lists of [[low, high], [high, low]]) expect(testSeeds('T1', lists, undefined)).toMatchObject({ seeds: b, branch: 'rule' });
  });

  it('stops on a unit table no repository can fit, naming the test', () => {
    expect(() => testSeeds('T1', [[{ repo: 'a', family: 'f', seed: 1, value: 0 }], []], undefined)).toThrow(/^T1: needs units in a repository with 2 families and 2 seeds$/);
  });

  it('uses the layout when it is given, so the count is the whole run\'s', () => {
    const wide = testSeeds('T2b', [heavy], Array.from({ length: 29 }, (_, i) => ({ repo: `w${i}`, k: 8 })));
    expect(wide.predictedSE.at9).toBeCloseTo(predictedSe(heavy, 9, { layout: Array.from({ length: 29 }, (_, i) => ({ repo: `w${i}`, k: 8 })) })!, 12);
    expect(wide.predictedSE.at9).not.toBeCloseTo(testSeeds('T2b', [heavy], undefined).predictedSE.at9, 6);
  });
});

describe('seedRule on generated batches', () => {
  const SETTINGS = { minimumEffect: 0.15, targetZ: 3.5, cap: 9, onMiss: 'cap', power: 0.8, sims: 20, seed: 1, bound: 0.8, firstWave: 3 };
  const pre = (source: string) => ({ schema: LEVELS_SCHEMA, source, commit: null, sources: [{ file: 'a', sha256: 'b' }], levels: Object.fromEntries(Object.entries(THRESHOLDS).map(([t, ths]) => [t, Object.fromEntries(ths.map((th) => [th, { level: Number(th), setBy: 'c', cells: [{ setting: 'c', size: 0, simError: 0 }] }]))])) });
  const levels = minLevels(pre('pre-freeze'), pre('batch-1'), () => {});

  it('returns counts for every rule arm under r4, S0 and S4 at 2, and meets checkRuleR4\'s conditions', () => {
    const g = generate({ design: DESIGNS.r4 });
    const got = seedRule(parse(g.records), g.plan, PRICES_BY_MODEL, { ...SETTINGS, design: DESIGNS.r4, costRatio: 1, levels });
    expect([got.stop, got.design]).toEqual([false, 'r4']);
    expect(Object.keys(got.perTest).sort()).toEqual(['H4', 'T1', 'T2a', 'T2b', 'T2c', 'T3']);
    const ruleArms = DESIGNS.r4.seedRule[0]!.arms;
    expect(Object.keys(got.seeds).sort()).toEqual([...ruleArms].sort());
    const counts: number[] = Object.values(got.seeds);
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]! >= 3 && counts[0]! <= 9 && Number.isInteger(counts[0])).toBe(true);
    expect(counts[0]).toBe(Math.max(...Object.values(got.perTest).map((t: any) => t.seeds)));
    for (const a of DESIGNS.r4.arms) expect(got.countsByArm[a], a).toBe(ruleArms.includes(a) ? got.seeds[a] : ARM_TABLE[a].seeds);
    expect([got.countsByArm.S0, got.countsByArm.S4]).toEqual([2, 2]);
    for (const t of Object.values<any>(got.perTest)) {
      expect(['rule', 'miss', 'cap']).toContain(t.branch);
      expect(t.branch === 'rule' ? t.power === null : Number.isFinite(t.power)).toBe(true);
    }
    expect(got.reasons.length).toBe(Object.values(got.perTest).filter((t: any) => t.branch !== 'rule').length);
  });

  it('returns counts under r4-on-r3 with no levels and no cost ratio, and sets the power of a miss at the nominal level', () => {
    const design = DESIGNS['r4-on-r3'];
    const heavyCost = (slot: { family: number | null }) => (slot.family === null ? 1 : 1 + 2 * ((slot.family * 5) % 4));
    const g = generate({ arms: R3_ARMS, knobs: { A2: { cost: heavyCost } } });
    const got = seedRule(parse(g.records), g.plan, PRICES_BY_MODEL, { ...SETTINGS, design, costRatio: 1 });
    expect([got.stop, got.design]).toEqual([false, 'r4-on-r3']);
    expect(got.perTest.T2a.branch).toBe('miss');
    expect(Number.isFinite(got.perTest.T2a.power)).toBe(true);
    expect(got.perTest.T2a.powerLevel).toBe('nominal');
    expect(got.reasons.some((r: string) => r.startsWith('T2a '))).toBe(true);
    const ruleArms = design.seedRule[0]!.arms;
    expect(Object.keys(got.seeds).sort()).toEqual([...ruleArms].sort());
  });

  it('refuses a stop on a miss under round 4, where a miss runs at the cap', () => {
    const g = generate({ arms: R3_ARMS });
    expect(() => seedRule(parse(g.records), g.plan, PRICES_BY_MODEL, { ...SETTINGS, onMiss: 'stop', design: DESIGNS['r4-on-r3'] })).toThrow(/a miss runs at the cap \(prereg item 10\)/);
  });

  it('under r4 needs a cost ratio and two levels files where a test needs its power', () => {
    const g = generate({ design: DESIGNS.r4 });
    const dir = dirWith({ 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES_BY_MODEL), 'a.json': JSON.stringify(pre('pre-freeze')) });
    const argv = ['--design', 'r4', '--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20'];
    expect(seedRuleCli(argv, dir)).toMatchObject({ code: 1, stderr: '--cost-ratio is required under round 4\n' });
    const one = seedRuleCli([...argv, '--cost-ratio', '1', '--levels', 'a.json'], dir);
    expect([one.code, one.stderr]).toEqual([1, '--levels: round 4 reads two levels files, the pre-freeze one and the batch-1 one (prereg Level check); got 1\n']);
  });
});

describe('a whole plan', () => {
  const batch = generate({ design: DESIGNS.r4, repos: 10 });
  const one = planOf(generate({ design: DESIGNS.r4, repos: 1 }).records);
  const files = {
    'runs.jsonl': jsonl(batch.records), 'plan.json': JSON.stringify(batch.plan), 'prices.json': JSON.stringify(PRICES_BY_MODEL),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`whole-${i + 1}.json`, JSON.stringify(one)])),
  };
  const dir = dirWith(files);
  const WHOLE = Array.from({ length: 8 }, (_, i) => ['--whole-plan', `whole-${i + 1}.json`]).flat();
  const BASE = ['--design', 'r4', '--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20', '--level-sims', '20'];
  const LAYOUT = "batch 1 holds 10 repositories; pass --whole-plan so the counts are the whole run's\n";

  it('heads 8 repositories in --seed-rule-preview, and writes the counts alone', () => {
    const run = sizeCli([...BASE, ...WHOLE, '--seed-rule-preview', '--out', 'preview.json'], dir);
    expect([run.code, run.stderr, run.stdout.split('\n')[0]]).toEqual([0, '', '8 repositories']);
    const preview = JSON.parse(fs.readFileSync(path.join(dir, 'preview.json'), 'utf8'));
    expect(Object.keys(preview).sort()).toEqual(['count', 'countsByArm', 'schema']);
    expect(preview.schema).toBe(SEED_PREVIEW_SCHEMA);
    const ruleArms: string[] = [...DESIGNS.r4.seedRule[0]!.arms];
    const ruleCounts = ruleArms.map((a) => preview.countsByArm[a]);
    expect(new Set(ruleCounts).size).toBe(1);
    expect(preview.count).toBe(ruleCounts[0]);
    expect([preview.countsByArm.S0, preview.countsByArm.S4]).toEqual([2, 2]);
    expect(Object.keys(preview.countsByArm).sort()).toEqual([...DESIGNS.r4.arms].sort());
  });

  it('heads 8 repositories in --level-check, and a batch-1 levels file names its source', () => {
    const run = sizeCli([...BASE, ...WHOLE, '--level-check', '--out', 'levels.json'], dir);
    expect([0, 3], run.stderr).toContain(run.code);
    expect(run.stdout.split('\n')[0]).toBe('8 repositories');
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'levels.json'), 'utf8'));
    expect([file.source, file.draws]).toEqual(['batch-1', 20]);
    expect(run.stdout).toMatch(/^LEVEL MS \d+/m);
    expect(file.floorFlags.length > 0).toBe(run.code === 3);
  });

  it('stops each mode that projects to the whole run, before any draw, when no --whole-plan is given', () => {
    const levels = ['--cost-ratio', '1', '--levels', 'a.json', '--levels', 'b.json'];
    for (const mode of [['--seed-rule-preview', '--out', 'p.json'], ['--level-check', '--out', 'l.json'], ['--power', ...levels]]) {
      const run = sizeCli([...BASE, ...mode], dir);
      expect([mode[0], run.code, run.stderr], mode[0]).toEqual([mode[0], 1, LAYOUT]);
    }
  });

  it('stops on a whole-plan file that holds two repositories, naming the file', () => {
    const two = JSON.stringify([...one, ...planOf(generate({ design: DESIGNS.r4, repos: 2 }).records).filter((c) => c.repo === 'repo2')]);
    const bad = dirWith({ ...files, 'whole-3.json': two });
    const run = sizeCli([...BASE, ...WHOLE, '--seed-rule-preview', '--out', 'p.json'], bad);
    expect([run.code, run.stderr]).toEqual([1, '--whole-plan whole-3.json: holds 2 repositories, and a file is one repository\n']);
  });
});

describe('the power read', () => {
  const FIGURES = { T1: 0.9, T3: 0.9, T2a: 0.9, T2b: 0.9, T2c: 0.9 };

  it('gives exit 3 and a STOP line when T1 is under 0.8, whatever else is', () => {
    expect(powerStop({ ...FIGURES, T1: 0.79, T3: 0.5, T2a: 0.5 })).toEqual({ code: 3, lines: ['STOP: T1 power 0.790'] });
  });

  it('gives exit 4 and one FOUNDER line per failing test when only T3 or a T2 part is under 0.8', () => {
    expect(powerStop({ ...FIGURES, T2b: 0.7 })).toEqual({ code: 4, lines: ['FOUNDER: T2b power 0.700: go on or stop'] });
    expect(powerStop({ ...FIGURES, T3: 0.75, T2c: 0.6 })).toEqual({ code: 4, lines: ['FOUNDER: T3 power 0.750: go on or stop', 'FOUNDER: T2c power 0.600: go on or stop'] });
  });

  it('gives exit 0 and no line at 0.8 and above, and skips a part with no figure', () => {
    expect(powerStop({ ...FIGURES, T1: 0.8, T3: 0.8 })).toEqual({ code: 0, lines: [] });
    expect(powerStop({ ...FIGURES, T2a: null })).toEqual({ code: 0, lines: [] });
  });

  it('runs the same draws at the same seed, 20261110 through cellSeed', () => {
    expect(R4_SEED).toBe(20261110);
  });

  const batch = generate({ design: DESIGNS.r4, repos: 10 });
  const one = planOf(generate({ design: DESIGNS.r4, repos: 1 }).records);
  const levelsOf = (source: string) => {
    const g = generate({ arms: R3_ARMS });
    const prepared = prepareR4(parse(g.records), g.plan, PRICES_BY_MODEL, { ...filterOpts({ design: DESIGNS['r4-on-r3'] }), spreadBound: 0.8 });
    const calm = (spec: any) => levelCells({ ...spec, sims: 2 }).map((c: { setting: string }) => ({ setting: c.setting, ps: Array.from({ length: spec.sims }, () => 1), noEstimate: 0 }));
    return { ...levelCheckR4(prepared, { levelSims: 20, source, commit: null, inputs: [] }, calm).file };
  };
  const files = {
    'runs.jsonl': jsonl(batch.records), 'plan.json': JSON.stringify(batch.plan), 'prices.json': JSON.stringify(PRICES_BY_MODEL),
    'pre.json': JSON.stringify(levelsOf('pre-freeze')), 'b1.json': JSON.stringify(levelsOf('batch-1')),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`whole-${i + 1}.json`, JSON.stringify(one)])),
  };
  const dir = dirWith(files);
  const WHOLE = Array.from({ length: 8 }, (_, i) => ['--whole-plan', `whole-${i + 1}.json`]).flat();
  const HEAD = ['--design', 'r4', '--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20', ...WHOLE, '--power'];
  const BOTH = ['--levels', 'pre.json', '--levels', 'b1.json'];
  const POWER = [...HEAD, ...BOTH];

  it('stops on one levels file under r4, naming the count, and on no cost ratio, naming the flag', () => {
    const one = sizeCli([...HEAD, '--levels', 'pre.json', '--cost-ratio', '1'], dir);
    expect([one.code, one.stderr]).toEqual([1, '--levels: round 4 reads two levels files, the pre-freeze one and the batch-1 one (prereg Level check); got 1\n']);
    const none = sizeCli(POWER, dir);
    expect([none.code, none.stderr]).toEqual([1, '--power needs --cost-ratio\n']);
  });

  it('heads 8 repositories, prints POWER MS, and exits with powerStop of its printed figures', () => {
    const run = sizeCli([...POWER, '--cost-ratio', '1'], dir);
    expect(run.stderr).toBe('');
    expect(run.stdout.split('\n')[0]).toBe('8 repositories');
    expect(run.stdout).toMatch(/^POWER MS \d+/m);
    const figures = Object.fromEntries(['T1', 'T3', 'T2a', 'T2b', 'T2c'].map((t) => [t, Number(/ figure (\d\.\d{3})/.exec(lineOf(run.stdout, new RegExp(`^${t} power`)))?.[1])]));
    expect(Object.values(figures).every(Number.isFinite)).toBe(true);
    const expected = powerStop(figures);
    expect(run.code).toBe(expected.code);
    for (const line of expected.lines) expect(run.stdout).toContain(line);
    expect(run.stdout.split('\n').filter((l) => /^(STOP|FOUNDER)/.test(l))).toEqual(expected.lines);
    expect(run.stdout).toMatch(/^bound T1 \+ T2a \+ T2b \+ T2c - 3: /m);
    expect(run.stdout).toMatch(/^bound T1 \+ T3 - 1: /m);
  });

  it('writes the part (a) effect as log(0.5 r) in settings: log(0.75) at r 1.5 and 0 at r 2', () => {
    for (const [r, effect] of [['1.5', Math.log(0.75)], ['2', 0]] as const) {
      const run = sizeCli([...POWER, '--cost-ratio', r, '--out', `power-${r}.json`], dir);
      expect([0, 3, 4], run.stderr).toContain(run.code);
      const settings = JSON.parse(fs.readFileSync(path.join(dir, `power-${r}.json`), 'utf8')).settings;
      expect(settings.costRatio).toBe(Number(r));
      expect(Math.abs(settings.partAEffect - effect)).toBeLessThan(1e-12);
    }
  });

  const LINE27 = 'attribution: A5 holds only part of it; A2 vs A5 violation 0.009 [-0.052, 0.070] t(13.5), bootstrap [-0.050, 0.068]; excluded 0.011 [-0.040, 0.062]';
  const unblind = (line: string) => Array.from({ length: 30 }, (_, i) => (i === 26 ? line : `line ${i + 1}`)).join('\n');

  it('prints round 3\'s A2 against A5 figures beside T3, and exits 1 naming the file when line 27 is something else', () => {
    const dir27 = dirWith({ ...files, 'unblind.txt': unblind(LINE27), 'wrong.txt': unblind('attribution: not run') });
    const run = sizeCli([...POWER, '--cost-ratio', '1', '--r3-unblind', 'unblind.txt'], dir27);
    expect([0, 3, 4], run.stderr).toContain(run.code);
    expect(lineOf(run.stdout, /^T3 round 3 /)).toBe('T3 round 3 unblind.txt line 27: A2 vs A5 violation 0.009 [-0.052, 0.070]');
    const wrong = sizeCli([...POWER, '--cost-ratio', '1', '--r3-unblind', 'wrong.txt'], dir27);
    expect([wrong.code, wrong.stdout]).toEqual([1, '']);
    expect(wrong.stderr).toContain('wrong.txt');
    expect(wrong.stderr).toContain('line 27');
  });

  it('under r4-on-r3 prints the T2 parts at 3, 3 and 5 seeds under the assumption heading, and never exits 3 or 4', () => {
    const g = generate({ arms: R3_ARMS });
    const d = dirWith({ 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES_BY_MODEL), 'pre.json': files['pre.json']! });
    const run = sizeCli(['--design', 'r4-on-r3', '--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20', '--power', '--cost-ratio', '1', '--levels', 'pre.json'], d);
    expect([run.code, run.stderr]).toEqual([0, '']);
    expect(run.stdout).toContain("assumption: round 3's same-model spreads (prereg item 12)");
    expect(lineOf(run.stdout, /^T2a at /)).toMatch(/^T2a at 3 seeds: /);
    expect(lineOf(run.stdout, /^T2b at /)).toMatch(/^T2b at 3 seeds: /);
    expect(lineOf(run.stdout, /^T2c at /)).toMatch(/^T2c at 5 seeds: /);
    expect(run.stdout).toMatch(/^POWER MS \d+/m);
    expect(run.stdout).not.toMatch(/^(STOP|FOUNDER)/m);
  });
});

describe('round 3 and the round 4 flags', () => {
  const g = generate({ repos: 4 });
  const dir = dirWith({ 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES) });
  const base = ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20'];
  const SIZE = [...base, '--repos', '5', '--effects', '0.2', '--search-sims', '20', '--level-sims', '20'];

  it('gives round 3\'s z0-size JSON, apart from five settings keys at their defaults, with and without --design r3', () => {
    const [plain, named] = [sizeCli(SIZE, dir), sizeCli([...SIZE, '--design', 'r3'], dir)];
    expect([plain.code, named.code]).toEqual([0, 0]);
    expect(sha(withoutInputs(plain.stdout, STRIPPED))).toBe('d75d36422afb307f88e1cddc0affbcad67bf6d75c78772a4e6e0500c3cb0dc46');
    expect(sha(withoutInputs(named.stdout, STRIPPED))).toBe('d75d36422afb307f88e1cddc0affbcad67bf6d75c78772a4e6e0500c3cb0dc46');
    expect(JSON.parse(plain.stdout).settings).toMatchObject({ design: 'r3', wholePlan: null, preLevels: null, costRatio: null, spendBasis: null });
  });

  it('gives round 3\'s z0-seed-rule JSON, apart from design and costRatio, with and without --design r3', () => {
    const [plain, named] = [seedRuleCli(base, dir), seedRuleCli([...base, '--design', 'r3'], dir)];
    expect([plain.code, named.code]).toEqual([0, 0]);
    for (const run of [plain, named]) expect(sha(withoutInputs(run.stdout, ['design', 'costRatio']))).toBe('bce8f3aff37f78ab1092a7f5882e4ed8eb5b8c718a550cddbb85d4e082d9f769');
    expect(JSON.parse(plain.stdout)).toMatchObject({ schema: 'z0-seed-rule/1', settings: { design: 'r3', costRatio: null } });
  });

  it('exits 1 with "round 4 only" for a mode or a round 4 flag under r3, and for --seed under round 4', () => {
    for (const extra of [['--power'], ['--level-check'], ['--cost-ratio', '1'], ['--whole-plan', 'x.json'], ['--levels', 'x.json'], ['--seed-rule-preview']]) {
      const run = sizeCli([...SIZE, ...extra], dir);
      expect([extra[0], run.code, run.stderr], extra[0]).toEqual([extra[0], 1, `${extra[0]}: round 4 only\n`]);
    }
    const seed = sizeCli([...base, '--design', 'r4-on-r3', '--seed', '3'], dir);
    expect([seed.code, seed.stderr]).toEqual([1, 'round 4 draws use seed 20261110 (prereg item 10)\n']);
  });

  it('allows one mode at a time', () => {
    const run = sizeCli([...base, '--design', 'r4-on-r3', '--power', '--level-check'], dir);
    expect([run.code, run.stderr]).toEqual([1, 'one mode at a time: --power, --level-check\n']);
  });

  it('prints T1, T2a, T2b, T2c, T3, H4 and T2aMiss under r4-on-r3, never H1 or H2, with its repositories and its counts', () => {
    const g3 = generate({ arms: R3_ARMS });
    const d = dirWith({ 'runs.jsonl': jsonl(g3.records), 'plan.json': JSON.stringify(g3.plan), 'prices.json': JSON.stringify(PRICES_BY_MODEL) });
    const run = sizeCli(['--design', 'r4-on-r3', '--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20'], d);
    expect([run.code, run.stderr]).toEqual([0, '']);
    expect(run.stdout.split('\n')[0]).toBe('6 repositories');
    for (const t of ['T1', 'T2a', 'T2b', 'T2c', 'T3', 'H4', 'T2aMiss']) expect(run.stdout, t).toMatch(new RegExp(`^${t} `, 'm'));
    expect(run.stdout).not.toMatch(/^H[12] /m);
    expect(lineOf(run.stdout, /^T2a /)).toContain('power n/a: needs --cost-ratio');
    expect(lineOf(run.stdout, /^T2aMiss /)).toMatch(/^T2aMiss .*at 3 seeds [\d.]+.*at 9 seeds [\d.]+.*bar [\d.]+.*seeds \d \((rule|miss)\)/);
  });
});
