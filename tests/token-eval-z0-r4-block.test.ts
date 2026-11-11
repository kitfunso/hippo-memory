// Round 4 prereg items 6 and 8: the batch 1 block reads gates and spreads blind, and stops on the causes the plan names, with the whole plan as the denominator.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { analyzeZ0, buildReport, loadInputs, parseArgs as parseAnalyze, renderText } from '../scripts/token-eval/z0-analyze.mjs';
import { BLOCK_SCHEMA, testLines } from '../scripts/token-eval/z0-batch1-block.mjs';
import { filterOpts, filteredInput } from '../scripts/token-eval/z0-filters.mjs';
import { parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { runCli as sizeCli } from '../scripts/token-eval/z0-size.mjs';
import { GRADING, PRICES_BY_MODEL, crash, generate, jsonl, planOf, type Z0Record } from './fixtures/z0-gen.js';

vi.setConfig({ testTimeout: 60_000 });

const ARM_WORD = /\b(O1|S0|S1|S2|S4|S5)\b/;
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const posix = (p: string) => p.replace(/\\/g, '/');
const one = planOf(generate({ design: DESIGNS.r4, repos: 1 }).records);

interface Batch { records: Z0Record[]; plan?: Z0Record[]; voids?: { sequence: string; seed: number; position: number }[]; whole?: number }

/** A batch folder: runs, plan, off-pin, grading, drop list, prices, the whole-plan files, and a read-set file naming the first three. */
function folder({ records, plan = records, voids = [], whole = 8 }: Batch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-r4-block-'));
  const put = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
  put('runs.jsonl', jsonl(records));
  put('plan.json', JSON.stringify(planOf(plan)));
  const offPin = { schema: 'z0-offpin/1', runs: [{ dir: 'r1', file: 'runs.jsonl', sha256: sha(path.join(dir, 'runs.jsonl')) }], voids: voids.map((v) => ({ arm: 'S1', sessionId: null, reason: 'cut', ...v })) };
  put('off-pin.json', JSON.stringify(offPin));
  put('grading.json', JSON.stringify(GRADING));
  put('drop-list.json', JSON.stringify({ droppedLessons: [], droppedFamilies: [], hookVoids: [] }));
  put('prices.json', JSON.stringify(PRICES_BY_MODEL));
  for (let i = 1; i <= whole; i++) put(`whole-${i}.json`, JSON.stringify(one));
  put('read-set.txt', `--runs ${posix(path.join(dir, 'runs.jsonl'))} --plan ${posix(path.join(dir, 'plan.json'))} --off-pin ${posix(path.join(dir, 'off-pin.json'))}\n`);
  return dir;
}
const argvOf = (whole = 8) => [
  '--design', 'r4', '--batch1-block', '--read-set', 'read-set.txt', '--grading', 'grading.json', '--drop-list', 'drop-list.json', '--prices', 'prices.json',
  ...Array.from({ length: whole }, (_, i) => ['--whole-plan', `whole-${i + 1}.json`]).flat(), '--key', 'key.json', '--out', 'block.json',
];
const blockOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'block.json'), 'utf8'));
const clean = () => generate({ design: DESIGNS.r4, repos: 6 }).records;

describe('the batch 1 block on a clean synthetic batch', () => {
  const dir = folder({ records: clean() });
  const run = sizeCli(argvOf(), dir);

  it('exits 0 and writes stops: [] with its schema', () => {
    expect([run.code, run.stderr]).toEqual([0, '']);
    expect(blockOf(dir)).toEqual({ schema: BLOCK_SCHEMA, stops: [] });
    expect(BLOCK_SCHEMA).toBe('z0-batch1-block/1');
  });

  it('holds no round 4 arm code as a word, and no estimate, mean or sign line', () => {
    expect(run.stdout).not.toMatch(ARM_WORD);
    expect(run.stdout).not.toMatch(/^STOP/m);
    expect(run.stdout).not.toMatch(/estimate|mean |difference/i);
  });

  it('prints the count and gate lines through G5 exactly as renderText does under the read set\'s own key', () => {
    const args = parseAnalyze(['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--grading', 'grading.json', '--drop-list', 'drop-list.json', '--off-pin', 'off-pin.json']);
    const inputs = loadInputs({ ...args, design: 'r4' }, dir);
    const analysis = analyzeZ0(inputs.records, { ...inputs, iterations: 10_000, seed: 1, unblind: false });
    const codes = JSON.parse(fs.readFileSync(path.join(dir, 'key.json'), 'utf8')).codes;
    const lines = renderText(buildReport(analysis, inputs, args, codes, []), DESIGNS.r4).split('\n');
    const expected = lines.slice(0, lines.findIndex((l: string) => l.startsWith('G5 ')) + 1);
    expect(run.stdout.split('\n').slice(0, expected.length)).toEqual(expected);
    expect(expected.some((l: string) => /^K\d+: /.test(l))).toBe(true);
  });

  it('prints the spread parts with upper bounds and the missing share per test, naRate and d of n for the repeat tests, and no list', () => {
    for (const t of ['T1', 'T3', 'T2a', 'T2b', 'T2c', 'H4']) expect(run.stdout, t).toMatch(new RegExp(`^${t}: .*family [\\d.]+ \\(upper [\\d.]+\\), seed [\\d.]+ \\(upper [\\d.]+\\), residual [\\d.]+ \\(upper [\\d.]+\\); missing [\\d.]+% of planned cells`, 'm'));
    for (const t of ['T1', 'T3', 'T2c']) expect(run.stdout, t).toMatch(new RegExp(`^${t}: .*not applicable [\\d.]+; \\d+ of \\d+ family units`, 'm'));
    for (const t of ['T2a', 'T2b', 'H4']) expect(run.stdout, t).not.toMatch(new RegExp(`^${t}: .*not applicable`, 'm'));
  });

  it('prints the same K codes on a second run, since --key is reused', () => {
    const again = sizeCli(argvOf(), dir);
    expect(again.stdout).toBe(run.stdout);
  });

  it('leaves its lines unchanged when the two arms of every pair swap', () => {
    const parsed = parseZ0Records(jsonl(clean()), 'runs.jsonl').records;
    const plan = planOf(clean());
    const tests: Record<string, string[]> = JSON.parse(JSON.stringify(DESIGNS.r4.tests));
    const swapped = { ...DESIGNS.r4, tests: Object.fromEntries(Object.entries(tests).map(([k, [a, b]]) => [k, [b, a]])) };
    const lines = (design: any) => {
      const { filtered, planCells } = filteredInput(parsed, plan, filterOpts({ design }), { dropAbandoned: true });
      return testLines(filtered, planCells, PRICES_BY_MODEL, design, 0.8);
    };
    const [a, b] = [lines(DESIGNS.r4), lines(swapped)];
    expect(a.length).toBe(6);
    expect(b).toEqual(a);
  });
});

describe('the batch 1 block stops', () => {
  const stopsOf = (batch: Batch, whole = 8) => {
    const dir = folder({ ...batch, whole });
    const run = sizeCli(argvOf(whole), dir);
    return { dir, run, stops: blockOf(dir).stops };
  };
  const expectStop = ({ run, stops }: ReturnType<typeof stopsOf>, id: string, line: RegExp) => {
    expect([run.code, run.stderr, stops]).toEqual([3, '', [id]]);
    expect(run.stdout.split('\n').filter((l: string) => l.startsWith('STOP: '))).toHaveLength(1);
    expect(run.stdout).toMatch(line);
  };
  const edit = (apply: (rs: Z0Record[]) => void) => {
    const records = clean();
    apply(records);
    return { records };
  };
  const first = (rs: Z0Record[], arm: string, sequence: string, seed: number, position: number) => rs.find((r) => r.arm === arm && r.sequence === sequence && r.seed === seed && r.position === position)!;

  it('stops on a G2 fail', () => {
    const records = generate({ design: DESIGNS.r4, repos: 6, knobs: { S4: { fail: 0.6 } } }).records;
    expectStop(stopsOf({ records }), 'g2', /^STOP: G2 fails/m);
  });

  it('stops on a G4 fail', () => {
    const batch = edit((rs) => {
      for (const r of rs) if (r.arm === 'S5' && r.set === 'N' && r.seed === 1) crash(r);
    });
    expectStop(stopsOf(batch), 'g4', /^STOP: G4 fails/m);
  });

  it('stops on each G1 run-level cause: a canary record, an outside name and ANTHROPIC_API_KEY', () => {
    const canary = edit((rs) => { first(rs, 'S1', 'rn-repo1', 1, 4).void = 'operator-canary'; });
    expectStop(stopsOf(canary), 'g1-run', /^STOP: G1 run-level: 1 operator canaries/m);
    const outside = edit((rs) => { Object.assign(first(rs, 'S1', 'rn-repo1', 1, 4), { envKeys: ['SOME_UNLISTED_NAME'] }); });
    expectStop(stopsOf(outside), 'g1-run', /^STOP: G1 run-level: env names outside the allowlist: SOME_UNLISTED_NAME in 1/m);
    const key = edit((rs) => { Object.assign(first(rs, 'S1', 'rn-repo1', 1, 4), { envKeys: ['ANTHROPIC_API_KEY'] }); });
    expectStop(stopsOf(key), 'g1-run', /^STOP: G1 run-level: .*1 records hold ANTHROPIC_API_KEY/m);
  });

  it('stops on off-pin voids above 5% of the whole plan\'s positions, and not on 4.2% of it, where batch 1 alone would stop', () => {
    const records = clean();
    const two = stopsOf({ records, voids: [{ sequence: 'rn-repo1', seed: 1, position: 0 }, { sequence: 'rn-repo2', seed: 1, position: 0 }] });
    expectStop(two, 'off-pin', /^STOP: off-pin voids reach 36 of 432 planned positions of the whole plan \(8\.3%\), over 5%/m);
    const lone = stopsOf({ records, voids: [{ sequence: 'rn-repo1', seed: 1, position: 0 }] });
    expect([lone.run.code, lone.stops]).toEqual([0, []]);
  });

  it('stops on G3 leaks above 5% of the whole plan\'s (sequence, seed)s, and not on one of 24, where batch 1 alone would stop', () => {
    const leak = (n: number) => edit((rs) => {
      for (let i = 1; i <= n; i++) Object.assign(first(rs, 'S1', `rn-repo${i}`, 1, 3), { invalid: 'leak', leak: true, resolved: false });
    });
    expectStop(stopsOf(leak(2)), 'g3', /^STOP: G3 2 of 24 planned \(sequence, seed\)s of the whole plan leaked, over 5%/m);
    const lone = stopsOf(leak(1));
    expect([lone.run.code, lone.stops]).toEqual([0, []]);
  });

  it('lists every stop in the order g1-run, g2, g4, off-pin, g3, one STOP line each', () => {
    const records = generate({ design: DESIGNS.r4, repos: 6, knobs: { S4: { fail: 0.6 } } }).records;
    Object.assign(first(records, 'S1', 'rn-repo1', 1, 4), { envKeys: ['ANTHROPIC_API_KEY'] });
    for (const r of records) if (r.arm === 'S1' && r.position < 5 && r.seed === 2) crash(r);
    for (let i = 1; i <= 2; i++) Object.assign(first(records, 'S1', `rn-repo${i}`, 1, 3), { invalid: 'leak', leak: true, resolved: false });
    const voids = [{ sequence: 'rn-repo3', seed: 1, position: 0 }, { sequence: 'rn-repo4', seed: 1, position: 0 }];
    const { run, stops } = stopsOf({ records, voids });
    expect(stops).toEqual(['g1-run', 'g2', 'g4', 'off-pin', 'g3']);
    expect(run.code).toBe(3);
    expect(run.stdout.split('\n').filter((l: string) => l.startsWith('STOP: ')).map((l: string) => l.split(/[ :]+/)[1])).toEqual(['G1', 'G2', 'G4', 'off-pin', 'G3']);
  });

  it('stops before any read when no --whole-plan is given, naming the batch\'s repositories', () => {
    const dir = folder({ records: clean() });
    const run = sizeCli(argvOf(0), dir);
    expect([run.code, run.stdout, run.stderr]).toEqual([1, '', "batch 1 holds 6 repositories; pass --whole-plan so the counts are the whole run's\n"]);
    expect(fs.existsSync(path.join(dir, 'block.json'))).toBe(false);
  });

  it('exits 1 on an abandoned run, which the block cannot read', () => {
    const plan = clean();
    const records = plan.filter((r) => !(r.sequence === 'rn-repo1' && r.seed === 1 && r.arm === 'S1' && r.position >= 10));
    const run = sizeCli(argvOf(), folder({ records, plan }));
    expect([run.code, run.stdout]).toEqual([1, '']);
    expect(run.stderr).toMatch(/abandoned/);
  });

  it('exits 1, naming the flag, when --key or --out is missing', () => {
    const dir = folder({ records: clean() });
    for (const flag of ['--key', '--out']) {
      const argv = argvOf();
      const at = argv.indexOf(flag);
      const run = sizeCli([...argv.slice(0, at), ...argv.slice(at + 2)], dir);
      expect([flag, run.code, run.stderr], flag).toEqual([flag, 1, `--batch1-block needs ${flag}\n`]);
    }
  });
});
