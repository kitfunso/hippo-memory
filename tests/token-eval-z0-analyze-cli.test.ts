/** Z0 analyzer CLI and blind mode on generated records; numbers in test names follow the plan's test list. */
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RN_ARMS, parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { pooledVoids } from '../scripts/token-eval/z0-blind.mjs';
import { analyzeZ0, runCli } from '../scripts/token-eval/z0-analyze.mjs';
import { ARMS, GRADING, PRICES, at, generate, jsonl, type Generated } from './fixtures/z0-gen.js';

const BASE = generate();
const fresh = (): Generated => structuredClone(BASE);

describe('Z0 CLI and blind mode', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const ARM_NAME = /\b(A0|A1|A2|A4|A5|X1|X2|X3|X4)\b/;
  const ARGS = ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--grading', 'grading.json'];
  function workspace(g: Generated): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-analyze-'));
    dirs.push(dir);
    const files = { 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES),
      'grading.json': JSON.stringify(GRADING), 'drop.json': JSON.stringify({ droppedLessons: [], droppedFamilies: [] }) };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    return dir;
  }

  it('16, 22, 23: blind output names no arm, pools void reasons, reuses its key, is deterministic and hashes its inputs', () => {
    const g = fresh();
    g.records[at(g.records, 'A1', 'rn-repo2', 1, 7)]!.void = 'received-hippo-text';
    g.records[at(g.records, 'X3', 'x-repo2', 1, 7)]!.void = 'read-past-transcript';
    const dir = workspace(g);
    const run = () => runCli([...ARGS, '--iterations', '300', '--out', 'out.json'], dir);
    const first = run();
    const out = fs.readFileSync(path.join(dir, 'out.json'), 'utf8');
    expect(first.code).toBe(0);
    for (const text of [first.stdout, out]) {
      expect(text).not.toMatch(ARM_NAME);
      expect(text).not.toMatch(/resolveRate|costPerResolved|staleFollow|verdict|adjustedP|voidReasons/);
    }
    const report = JSON.parse(out);
    expect(report.voids).toEqual({ total: 2, reasons: { 'read-past-transcript': 1, 'received-hippo-text': 1 } });
    expect(pooledVoids({ A1: { voids: 1, voidReasons: { x: 1 } }, A2: { voids: 0, voidReasons: {} } })).toEqual({ total: 1 });
    expect(first.stdout).toContain('hypotheses sealed until unblinded');
    expect(first.stdout).toContain('not of record');
    expect(first.stdout).toMatch(/^status: valid$/m);
    const key = fs.readFileSync(path.join(dir, 'z0-blind-key.json'), 'utf8');
    expect(Object.values(JSON.parse(key).codes).sort()).toEqual(ARMS.map((_, i) => `K${i + 1}`).sort());
    expect([run().code, fs.readFileSync(path.join(dir, 'z0-blind-key.json'), 'utf8'), fs.readFileSync(path.join(dir, 'out.json'), 'utf8')]).toEqual([0, key, out]);
    const repo = path.resolve(__dirname, '..');
    for (const h of report.hashes) {
      const file = h.role === 'source' ? path.join(repo, h.file) : path.join(dir, h.file);
      expect(h.sha256).toBe(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
    expect(report.hashes.map((h: { role: string }) => h.role).filter((r: string) => r === 'source')).toHaveLength(8);
    fs.writeFileSync(path.join(dir, 'z0-blind-key.json'), JSON.stringify({ codes: { A0: 'K1', A1: 'K2' } }));
    expect(run()).toMatchObject({ code: 1, stderr: expect.stringMatching(/another arm set/) });
  });

  it('17: unblind needs a committed drop list and grading file and a passing G5', () => {
    const dir = workspace(generate({ repos: 3 }));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    for (const [k, v] of [['user.name', 'z0 test'], ['user.email', 'z0@example.invalid'], ['core.hooksPath', '.no-hooks'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
    const unblind = (extra: string[] = []) => runCli([...ARGS, '--drop-list', 'drop.json', '--unblind', ...extra], dir);
    const edit = (f: string, text: string) => fs.writeFileSync(path.join(dir, f), text);
    expect(unblind().code).toBe(2);
    git('add', 'drop.json');
    git('commit', '-qm', 'drop list');
    expect(unblind()).toMatchObject({ code: 2, stderr: expect.stringMatching(/grading\.json is not tracked/) });
    git('add', 'grading.json');
    git('commit', '-qm', 'grading');
    const drop = fs.readFileSync(path.join(dir, 'drop.json'), 'utf8');
    edit('drop.json', `${drop}\n`);
    expect(unblind()).toMatchObject({ code: 2, stderr: expect.stringMatching(/drop\.json has uncommitted changes/) });
    edit('drop.json', drop);
    edit('grading.json', JSON.stringify({ ...GRADING, readerSample: { n: 30, disagreements: 4 } }));
    git('commit', '-qam', 'regrade needed');
    expect(unblind()).toMatchObject({ code: 2, stderr: expect.stringMatching(/re-grade required/) });
    edit('grading.json', JSON.stringify(GRADING));
    git('commit', '-qam', 'regraded');
    expect(runCli([...ARGS.slice(0, 6), '--drop-list', 'drop.json', '--unblind'], dir)).toMatchObject({ code: 2, stderr: expect.stringMatching(/grading file missing/) });
    expect(unblind(['--iterations', '300']).code).toBe(2);
    const open = unblind(['--out', 'open.json']);
    expect(open.code).toBe(0);
    expect(open.stdout).toMatch(/^H1 \w+/m);
    expect(open.stdout).toMatch(/^ {2}tasksSinceTeach 2-4: A2 - A1 .*; rates \(violation\/excluded\) A0 [\d.]+\/[\d.]+ \(seeds 1,2\), A1 [\d.]+\/[\d.]+ \(seeds 1,2,3\), /m);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'open.json'), 'utf8')).hypotheses.verdicts.H1.final.verdict).toBeTruthy();
    const bad = generate({ repos: 3 });
    bad.records[0]!.void = 'operator-canary';
    edit('runs.jsonl', jsonl(bad.records));
    const shut = unblind();
    expect([shut.code, ARM_NAME.test(shut.stdout), /^H1 /m.test(shut.stdout)]).toEqual([0, true, false]);
    expect(shut.stdout).toContain('invalid: G1');
    expect(shut.stdout).toMatch(/^status: invalid$/m);
  });

  it('24, 30: an abandoned run prints its status and cell counts and no gate; an unplanned set is named under the status line', () => {
    const cut = fresh();
    cut.records = cut.records.filter((r) => !(r.sequence === 'rn-repo5' && r.seed === 2 && r.position >= 8));
    const dir = workspace(cut);
    const out = runCli([...ARGS, '--iterations', '300'], dir);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^status: abandoned$/m);
    expect(out.stdout).toContain('abandoned: rn-repo5 seed 2');
    expect(out.stdout).toMatch(/^K\d+: .*, missing 0 \(0\.0%\), abandoned tail 10$/m);
    expect(out.stdout).not.toMatch(/^G\d|^valid|^invalid/m);
    expect(out.stdout).toContain('not analysed: the run is abandoned (prereg 114)');
    expect(runCli([...ARGS, '--drop-list', 'drop.json', '--unblind'], dir)).toMatchObject({ code: 2, stderr: expect.stringMatching(/abandoned/) });
    const rn = runCli([...ARGS, '--iterations', '300'], workspace(generate({ arms: RN_ARMS, repos: 2 })));
    expect(rn.stdout).toMatch(/^status: valid\ndesign not fully run: X1, X2, X3, X4, set X not planned$/m);
  });

  it('36: a planned set with no records is abandoned data, never "not planned"', () => {
    const noX = fresh();
    noX.records = noX.records.filter((r) => r.set !== 'X');
    const lost = runCli([...ARGS, '--iterations', '300'], workspace(noX));
    expect(lost.stdout).toMatch(/^status: abandoned$/m);
    expect(lost.stdout).not.toContain('not planned');
  });

  it('32: the same --runs files in either order give the same report', () => {
    const g = fresh();
    const dir = workspace(g);
    const half = (low: boolean) => g.records.filter((r) => (Number(r.repo.slice(4)) <= 3) === low);
    fs.writeFileSync(path.join(dir, 'a.jsonl'), jsonl(half(true)));
    fs.writeFileSync(path.join(dir, 'b.jsonl'), jsonl(half(false)));
    const report = (first: string, second: string) => {
      const argv = ['--runs', first, '--runs', second, ...ARGS.slice(2), '--iterations', '300', '--key', 'key.json', '--out', 'o.json'];
      expect(runCli(argv, dir).code).toBe(0);
      const r = JSON.parse(fs.readFileSync(path.join(dir, 'o.json'), 'utf8'));
      return { ...r, hashes: null, warnings: null };
    };
    expect(report('b.jsonl', 'a.jsonl')).toEqual(report('a.jsonl', 'b.jsonl'));
    const open = (first: Generated['records'], second: Generated['records']) => {
      const records = [...parseZ0Records(jsonl(first), 'x').records, ...parseZ0Records(jsonl(second), 'y').records];
      const a = analyzeZ0(records, { planCells: g.plan, prices: PRICES, grading: GRADING, unblind: true, refuse: () => null, iterations: 300, seed: 1 });
      return [a.hypotheses, a.reported];
    };
    expect(open(half(false), half(true))).toEqual(open(half(true), half(false)));
  });

  it('39: --out in a missing folder exits 1 with a plain message before the key is written', () => {
    const dir = workspace(fresh());
    const out = runCli([...ARGS, '--iterations', '300', '--out', 'nope/o.json'], dir);
    expect(out).toEqual({ code: 1, stdout: '', stderr: `--out nope/o.json: folder ${path.join(dir, 'nope')} does not exist\n` });
    expect(fs.existsSync(path.join(dir, 'z0-blind-key.json'))).toBe(false);
  });

  it('E3b 30: a scored storedSample is accepted and printed in blind mode; a malformed one is refused; absent prints nothing new', () => {
    const dir = workspace(fresh());
    const run = () => runCli([...ARGS, '--iterations', '300', '--out', 'o.json'], dir);
    const before = run();
    expect(before.stdout).not.toContain('stored sample');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'o.json'), 'utf8')).storedSample).toBeNull();
    const stored = { n: 30, agree: 27, agreement: 0.9, ci95: [0.7438, 0.9654], kappa: 0.8, table: { yesYes: 14, yesNo: 1, noYes: 2, noNo: 13 }, excluded: { cut: 1, empty: 0, hiddenHit: 0 } };
    fs.writeFileSync(path.join(dir, 'grading.json'), JSON.stringify({ ...GRADING, storedSample: stored }));
    const shown = run();
    expect(shown.code).toBe(0);
    expect(shown.stdout).toMatch(/^G5 .*\nstored sample \(179\): agreement 0\.900 \[0\.744, 0\.965\], kappa 0\.800, n 30$/m);
    expect(shown.stdout).not.toMatch(ARM_NAME);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'o.json'), 'utf8')).storedSample).toEqual(stored);
    fs.writeFileSync(path.join(dir, 'grading.json'), JSON.stringify({ ...GRADING, storedSample: { ...stored, kappa: null } }));
    expect(run().stdout).toContain('kappa n/a, n 30');
    for (const bad of [{ ...stored, agree: 31 }, { ...stored, n: 1.5 }, { ...stored, agreement: 'high' }, null]) {
      fs.writeFileSync(path.join(dir, 'grading.json'), JSON.stringify({ ...GRADING, storedSample: bad }));
      expect(run()).toMatchObject({ code: 1, stderr: expect.stringContaining('storedSample needs n and agree') });
    }
  });

  it('--help prints the usage and exits 0', () => {
    expect(runCli(['--help'])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^usage: z0-analyze\.mjs --runs FILE/) });
  });
});
