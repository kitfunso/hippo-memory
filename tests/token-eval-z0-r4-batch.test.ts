// Round 4 Failure and Record models: z0-unit-record's reads, then s4-batch.sh over stub launchers and stub node runners (plan :240, :241).
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { gitBash } from '../scripts/token-eval/homes.mjs';
import { callRecord, pathForm, runCli, unitRecord } from '../scripts/token-eval/z0-unit-record.mjs';
import { CHECKOUT, COST, Case, WARM, fwd, isAlive, json, keepDir, lines, put, read, sleep, stopCases, until, within, type Knobs, type Run, type Started } from './fixtures/z0-batch/harness.js';
import { killOwnTree } from './fixtures/kill-own.js';
import { cleanup, tmp } from './fixtures/z0-harness.js';
import { cli, sealedKey, synthOut, type Cell } from './fixtures/z0-g5.js';
import { generate, planOf } from './fixtures/z0-gen.js';

// The process scan, the stub launchers and the stub runners are slow: one batch case runs minutes, and a case waits for its whole scenario.
vi.setConfig({ testTimeout: 3_600_000, hookTimeout: 3_600_000 });

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/* ------------------------------------------------------------------------------------------------ z0-unit-record */

const GEN = generate({ design: DESIGNS.r4, repos: 1 });
const SEED1 = GEN.records.filter((r) => r.seed === 1);

describe('z0-unit-record unit (the Record model: complete records)', () => {
  afterEach(cleanup);
  interface UnitOpts { count?: number; torn?: boolean; abandoned?: boolean; plan?: 'ok' | 'none' | 'torn'; log?: (dir: string) => string; badMiddle?: boolean }
  function unitFolder(o: UnitOpts = {}) {
    const dir = fwd(tmp('z0-unit-'));
    const records = SEED1.slice(0, o.count ?? SEED1.length).map((r) => JSON.stringify(r));
    if (o.badMiddle) records.splice(1, 0, '{"arm": "O1", "tor');
    put(`${dir}/run/runs.jsonl`, `${records.join('\n')}\n${o.torn ? '{"arm":"O1","seq' : ''}`);
    if (o.plan !== 'none') put(`${dir}/run/plan.json`, o.plan === 'torn' ? JSON.stringify(planOf(SEED1)).slice(0, 40) : JSON.stringify(planOf(SEED1)));
    if (o.abandoned) put(`${dir}/run/ABANDONED`, '');
    if (o.log) put(`${dir}/run.log`, o.log(dir));
    return dir;
  }
  const back = (p: string) => p.replace(/\//g, '\\');

  it('reads the Records: line as done whatever the slashes and case, and not when it names another folder', () => {
    const dir = unitFolder({ count: 1, log: (d) => `noise\r\n\r\nRecords: ${back(d).toUpperCase()}\\RUN\\RUNS.JSONL\r\nAnalyze with x\r\n` });
    expect(unitRecord(dir)).toBe(`record done ${dir} records-line`);
    const other = unitFolder({ count: 1, log: () => 'Records: C:\\somewhere\\else\\run\\runs.jsonl\n' });
    expect(unitRecord(other)).toBe(`record none ${other} missing ${SEED1.length - 1} of ${SEED1.length} cells`);
    expect(unitRecord(unitFolder({ count: 1, log: (d) => `Records: /${d[0].toLowerCase()}/${d.slice(3)}/run/runs.jsonl\n` }))).toMatch(/records-line$/);
  });

  it('reads every planned cell with a record as done, a torn last line skipped', () => {
    const dir = unitFolder({ torn: true });
    expect(unitRecord(dir)).toBe(`record done ${dir} all-records`);
  });

  it('names one record short, an ABANDONED mark, an absent plan and a torn plan', () => {
    const n = SEED1.length;
    expect(unitRecord(unitFolder({ count: n - 1 }))).toMatch(new RegExp(`missing 1 of ${n} cells$`));
    expect(unitRecord(unitFolder({ abandoned: true }))).toMatch(/record none .* abandoned$/);
    expect(unitRecord(unitFolder({ plan: 'none' }))).toMatch(/no-plan$/);
    expect(unitRecord(unitFolder({ plan: 'torn' }))).toMatch(/no-plan$/);
  });

  it('exits 1 naming the file and line for a bad line that is not the last', () => {
    const dir = unitFolder({ badMiddle: true });
    expect(runCli(['unit', dir])).toMatchObject({ code: 1, stderr: expect.stringContaining('runs.jsonl line 2: not a JSON record') });
    expect(runCli(['unit'])).toMatchObject({ code: 1, stderr: expect.stringContaining('usage: z0-unit-record.mjs unit FOLDER') });
  });

  it('writes the same path form the scan prints', () => {
    expect(pathForm('C:\\Z0-Runs\\R4\\')).toBe('c:/z0-runs/r4');
    expect(pathForm('/C/Users/x')).toBe('c:/users/x');
    expect(pathForm('/')).toBe('/');
  });
});

describe('z0-unit-record call (each call\'s summary line)', () => {
  afterEach(cleanup);
  const logged = (call: string, ...text: string[]) => {
    const dir = fwd(tmp('z0-call-'));
    if (text.length > 0) put(`${dir}/g5-${call}.log`, text.join('\n'));
    return dir;
  };
  const done = (dir: string, call: string) => `record done ${dir} ${call}`;

  it('reads a summary taken from its producer as done: the reader draw and score, and grading', () => {
    const cells: Cell[] = Array.from({ length: 4 }, (_, i) => ({ arm: 'A0', position: i, first: 'pass' }));
    const s = synthOut(cells);
    const drew = cli(['reader', '--out', s.out, '--tasks', s.tasks, '--seed', '7']);
    expect(drew.code).toBe(0);
    const labels = `${tmp('z0-call-labels-')}/labels.tsv`;
    put(labels, sealedKey(s.out, 'reader-r1.key.json').pairs.map((p: { file: string; verdict: string }) => `${p.file}\t${p.verdict}\t\n`).join(''));
    const scored = cli(['reader', '--out', s.out, '--labels', labels]);
    expect(scored.code).toBe(0);
    const graded = cli(['grading', '--out', s.out]);
    expect(graded).toMatchObject({ code: 0 });
    for (const [call, run] of [['reader-draw', drew], ['reader-score', scored], ['grading', graded]] as const) {
      const dir = logged(call, 'earlier line', run.stdout.trim());
      expect(callRecord(dir, call)).toBe(done(dir, call));
    }
  });

  it('reads the regrade, stored draw and stored score lines copied from their producers (z0-regrade.mjs:90, stored-sample.mjs:58, :80, :92)', () => {
    const regraded = logged('regrade', 'repro: regraded 12 cells (0 with errors), skipped 3 done ones; wrote 12\n');
    expect(callRecord(regraded, 'regrade')).toBe(done(regraded, 'regrade'));
    const post = logged('regrade', 'postfix: regraded 0 cells (0 with errors), skipped 15 done ones\n');
    expect(callRecord(post, 'regrade')).toBe(done(post, 'regrade'));
    for (const [call, line] of [['stored-draw', 'stored sample: drew 2 units'], ['stored-draw', 'stored sample: already drawn, 2 units'], ['stored-score', 'stored sample: 1 of 2 labels agree with the key-phrase judgement'], ['reader-draw', 'reader round 1: already drawn, 5 pairs']] as const) {
      const dir = logged(call, line);
      expect(callRecord(dir, call)).toBe(done(dir, call));
    }
  });

  it('gives error-rows for a regrade with errors, no-summary for an error line, and no-log for none', () => {
    const errors = logged('regrade', 'repro: regraded 12 cells (2 with errors), skipped 0 done ones; wrote 10\n');
    expect(callRecord(errors, 'regrade')).toBe(`record none ${errors} error-rows 2`);
    const failed = logged('reader-score', 'labels line 2: unknown id p03\n');
    expect(callRecord(failed, 'reader-score')).toBe(`record none ${failed} no-summary`);
    const bare = logged('grading');
    expect(callRecord(bare, 'grading')).toBe(`record none ${bare} no-log`);
    expect(runCli(['call', bare, 'nope'])).toMatchObject({ code: 1 });
  });
});

describe('z0-unit-record keys, arms, max-seed, labels, seeds and toolchain', () => {
  afterEach(cleanup);
  const root = (pins: { batch1Keys?: string; batch2Keys?: string }) => {
    const dir = fwd(tmp('z0-keys-'));
    put(`${dir}/pins-r4.json`, JSON.stringify(pins));
    return dir;
  };

  it('lists the keys of batch 1, batch 2, and both for the raise, one per line', () => {
    const dir = root({ batch1Keys: 'q145,q14', batch2Keys: 'qa,qb' });
    expect(runCli(['keys', dir, '1']).stdout).toBe('q145\nq14\n');
    expect(runCli(['keys', dir, '2']).stdout).toBe('qa\nqb\n');
    expect(runCli(['keys', dir, 'raise']).stdout).toBe('q145\nq14\nqa\nqb\n');
    expect(runCli(['keys', dir, '3'])).toMatchObject({ code: 1 });
  });

  it('gives the six arms for a first run and the rule arms for a raise first run', () => {
    expect(runCli(['arms', 'first', '1']).stdout).toBe('O1,S0,S1,S2,S4,S5\n');
    expect(runCli(['arms', 'first', '2']).stdout).toBe('O1,S0,S1,S2,S4,S5\n');
    expect(runCli(['arms', 'first', 'raise']).stdout).toBe('O1,S1,S2,S5\n');
  });

  it('gives a rerun the arms its first run planned at that seed: all six at 1 and 2, the rule arms at 3', () => {
    const dir = fwd(tmp('z0-rerun-'));
    put(`${dir}/run/plan.json`, JSON.stringify(planOf(GEN.records)));
    expect(runCli(['arms', 'rerun', dir, '1']).stdout).toBe('O1,S0,S1,S2,S4,S5\n');
    expect(runCli(['arms', 'rerun', dir, '2']).stdout).toBe('O1,S0,S1,S2,S4,S5\n');
    expect(runCli(['arms', 'rerun', dir, '3']).stdout).toBe('O1,S1,S2,S5\n');
    expect(runCli(['arms', 'rerun', dir, '4'])).toMatchObject({ code: 1, stderr: expect.stringContaining('plans no cell at seed 4') });
  });

  it('reads the sealed raise cap, and refuses an absent, malformed or non-integer one', () => {
    const dir = root({});
    expect(runCli(['max-seed', dir])).toMatchObject({ code: 1, stderr: expect.stringContaining('no such file') });
    put(`${dir}/raise/max-seed.json`, '{"maxSeed": ');
    expect(runCli(['max-seed', dir])).toMatchObject({ code: 1, stderr: expect.stringContaining('sealed file does not parse') });
    put(`${dir}/raise/max-seed.json`, '{"maxSeed": 2.5}');
    expect(runCli(['max-seed', dir])).toMatchObject({ code: 1, stderr: expect.stringContaining('positive integer') });
    put(`${dir}/raise/max-seed.json`, '{"maxSeed": 5, "count": 12}');
    expect(runCli(['max-seed', dir]).stdout).toBe('max-seed 5\n');
  });

  it('counts the empty labels of a template, a filled file, one empty row, and a BOM and CRLF file', () => {
    const dir = fwd(tmp('z0-labels-'));
    const file = (name: string, text: string) => { put(`${dir}/${name}`, text); return `${dir}/${name}`; };
    const head = '# id\tlabel (pass, fail)\tnote\n';
    expect(runCli(['labels', file('t.tsv', `${head}p1\t\t\np2\t\t\n`)]).stdout).toBe(`labels empty 2 ${dir}/t.tsv\n`);
    expect(runCli(['labels', file('f.tsv', `${head}p1\tpass\t\np2\tfail\t\n`)]).stdout).toBe(`labels filled ${dir}/f.tsv\n`);
    expect(runCli(['labels', file('o.tsv', `${head}p1\tpass\t\np2\t \t\n`)]).stdout).toBe(`labels empty 1 ${dir}/o.tsv\n`);
    expect(runCli(['labels', file('b.tsv', `\uFEFF# id\tlabel\tnote\r\n\r\np1\tpass\t\r\np2\t\t\r\n`)]).stdout).toBe(`labels empty 1 ${dir}/b.tsv\n`);
    expect(runCli(['labels', `${dir}/absent.tsv`])).toMatchObject({ code: 1 });
  });

  it('lists the distinct leaked seeds ascending, and reads a key\'s toolchain from the repos file', () => {
    const dir = fwd(tmp('z0-seeds-'));
    put(`${dir}/leaks.json`, JSON.stringify({ leaks: [{ sequence: 's', seed: 3 }, { sequence: 's', seed: 1 }, { sequence: 't', seed: 3 }] }));
    expect(runCli(['seeds', `${dir}/leaks.json`]).stdout).toBe('1\n3\n');
    put(`${dir}/repos.json`, JSON.stringify({ q14: { toolchain: 'python' }, bad: {} }));
    expect(runCli(['toolchain', 'q14', `${dir}/repos.json`]).stdout).toBe('python\n');
    expect(runCli(['toolchain', 'bad', `${dir}/repos.json`])).toMatchObject({ code: 1, stderr: expect.stringContaining('bad has no toolchain name') });
  });

  it('reads the sealed files a call leaves: a call that seals none, a missing file, one that does not parse, and grading needing all four', () => {
    const dir = fwd(tmp('z0-sealed-'));
    const sealed = `${dir}/run/g5/sealed`;
    expect(runCli(['sealed', dir, 'regrade']).stdout).toBe(`sealed ok ${dir} regrade\n`);
    expect(runCli(['sealed', dir, 'stored-draw'])).toMatchObject({ code: 1, stderr: expect.stringContaining('stored.key.json: sealed file is missing; call stored-draw seals it') });
    put(`${sealed}/stored.key.json`, '{"units": ["u1"]}');
    expect(runCli(['sealed', dir, 'stored-draw']).stdout).toBe(`sealed ok ${dir} stored-draw\n`);
    put(`${sealed}/stored.score.json`, '{"labels": ');
    expect(runCli(['sealed', dir, 'stored-score'])).toMatchObject({ code: 1, stderr: expect.stringContaining('stored.score.json: sealed file does not parse') });
    put(`${sealed}/stored.score.json`, '{"labels": {}}');
    expect(runCli(['sealed', dir, 'stored-score']).stdout).toBe(`sealed ok ${dir} stored-score\n`);
    expect(runCli(['sealed', dir, 'grading'])).toMatchObject({ code: 1, stderr: expect.stringContaining('reader-r1.key.json: sealed file is missing; call grading seals it') });
    expect(runCli(['sealed', dir, 'nope'])).toMatchObject({ code: 1 });
  });
});

/* ------------------------------------------------------------------------------------------------ s4-batch.sh */

const win = process.platform === 'win32';
const cases: Case[] = [];
const track = (c: Case) => { cases.push(c); return c; };
const at = (c: Case, prefix: string, from = 0) => c.log().findIndex((l, i) => i >= from && l.startsWith(prefix));
const cmds = (c: Case, cli: string) => c.log().filter((l) => l.startsWith(`cmd ${cli} `));
const KEY_FX = (c: Case, key: string, seeds = [1, 2, 3], extra: { leaks?: number[]; tag?: string } = {}) => c.fx(`${key}-${seeds.join('')}${extra.tag ?? ''}`, { key, seeds, ...extra });
const units = (c: Case, fn: string, ...args: string[]) => spawnSync(gitBash(process.env, []), [`${c.scored}/s4-units.sh`, fn, ...args], { env: { ...c.env(), Z0_CHECKOUT: CHECKOUT }, encoding: 'utf8', cwd: c.base });

/** Starts the stub runner under a given `--out`, as a scan test's live process; its output goes to the folder's run.log. */
function liveRunner(c: Case, out: string, spell = out, knob: Knobs = { records: 0, hang: true, printRecords: false }) {
  const folder = path.dirname(out);
  fs.mkdirSync(folder, { recursive: true });
  const fd = fs.openSync(`${folder}/run.log`, 'a');
  c.knob(path.basename(folder), { fixture: KEY_FX(c, 'sx', [1]), ...knob });
  const child = spawn(process.execPath, [`${c.scored}/ab-run.mjs`, '--out', spell], { env: c.env(), stdio: ['ignore', fd, fd], windowsHide: true, cwd: c.base });
  fs.closeSync(fd);
  return child.pid!;
}

/** Tree-kills a started batch (by Win32 parent links with a start-time check, so no other case's process that inherited a reused parent pid dies) and returns once the listing holds no s4-batch.sh line for its root, the condition a restart checks. */
async function killBatch(c: Case, s: Started) {
  killOwnTree(s.child);
  const run = await within(s.done, 60_000, `killBatch: the tree-killed batch ${s.child.pid} to exit`);
  // The Git Bash wrapper's exit is not its forks': one forked during the tree kill outlives it, and a restart rightly refuses while it lives.
  await until(`killBatch: no s4-batch.sh line for ${c.root} after the tree kill`, () => {
    const r = units(c, 'batch_lines', c.root);
    return r.status === 0 && r.stdout === '';
  }, 120_000);
  return run;
}

/** Waits for a line of the batch's log past `from` that passes `test`, or for the batch to end without one; returns the line's index, or -1. */
async function lineOf(c: Case, s: Started, from: number, what: string, test: (l: string) => boolean) {
  let ended = false;
  void s.done.then(() => { ended = true; });
  let found = -1;
  await until(what, () => {
    found = c.log().findIndex((l, i) => i >= from && test(l));
    return found >= 0 || ended;
  });
  return found;
}

/** Puts `release` once a line of the batch's log past `from` starts with `prefix` and names `name`, or once the batch ends without one, so held stubs last until that line on any box. */
async function releaseOn(c: Case, s: Started, from: number, prefix: string, name: string, release: string): Promise<Run> {
  await lineOf(c, s, from, `a "${prefix}" line naming ${name}`, (l) => l.startsWith(prefix) && l.includes(name));
  put(release, '');
  return s.done;
}

/** True once the held runner of unit folder `name` advances its beat file, so it is alive and held now; false after 30 s without. */
async function heartbeat(c: Case, name: string) {
  const file = `${c.dir(name)}/held.beat`;
  const count = () => (fs.existsSync(file) ? Number(read(file) || Number.NaN) : 0);
  let first = Number.NaN;
  return until(`a heartbeat of ${name}`, () => {
    const n = count();
    if (Number.isNaN(first)) first = n;
    else if (n > first) return true;
    return false;
  }, 30_000).then(() => true, () => false);
}
/** One batch started over held stubs, released once it logs a wait for `name`. */
function startHeld(c: Case, name: string, release: string) {
  const from = c.log().length;
  return releaseOn(c, c.start(), from, 'wait for ', name, release);
}

/** A case that stops at the first `BATCH` line it does not name; every scenario below is one root, one story, and a few named assertions. */
const A = async () => {
  const c = track(new Case({ name: 'A', keys1: ['q145', 'q14'] }));
  const f = { q145: KEY_FX(c, 'q145', [1, 2, 3], { leaks: [1, 3] }), q14: KEY_FX(c, 'q14'), e1: KEY_FX(c, 'q145', [1], { tag: 'r' }), e3: KEY_FX(c, 'q145', [3], { tag: 'r' }) };
  const cut = { records: 1, exit: 1, printRecords: false };
  c.knob('q145-w1', { fixture: f.q145 });
  c.knob('q14-w1', { fixture: f.q14, ...cut });
  c.knob('q14-w1-a2', { fixture: f.q14 });
  c.knob('q145-e1', { fixture: f.e1 });
  c.knob('q145-e3', { fixture: f.e3, ...cut });
  c.knob('q145-e3-a2', { fixture: f.e3 });
  const calls: Run[] = [];
  calls.push(await c.run());
  put(`${c.root}/batch1/done/q145-w1.tmp-77`, 'q145-w');
  calls.push(await c.run());
  const afterCall2 = { tmpLeft: c.markers().filter((m) => m.includes('.tmp-')), q145w1: read(`${c.root}/batch1/done/q145-w1`) };
  put(`${c.dir('q14-w1-a2')}/run/g5/sealed/reader-r1.key.json.tmp-5`, '{"pairs": [');
  put(`${c.dir('q14-w1-a2')}/run/grading.json.tmp-5`, '{"g5"');
  calls.push(await c.run());
  const folders = ['q145-w1', 'q145-e1', 'q145-e3-a2', 'q14-w1-a2'];
  const grading0 = folders.map((n) => fs.existsSync(`${c.dir(n)}/run/grading.json`));
  c.fillLabels(folders);
  calls.push(await c.run());
  const scale = read(`${c.root}/scale.json`);
  const scaleTime = fs.statSync(`${c.root}/scale.json`).mtimeMs;
  const launchesBefore = c.launches().length;
  calls.push(await c.run());
  return { c, calls, folders, grading0, afterCall2, scale, scaleTime, launchesBefore, f };
};

const B = async () => {
  const keys = ['ba', 'bb', 'bc', 'bd'];
  const c = track(new Case({ name: 'B', keys1: keys, width: 2 }));
  for (const k of keys) c.knob(`${k}-w1`, { fixture: KEY_FX(c, k), startMs: 1200 });
  c.knob('ba-w1', { fixture: KEY_FX(c, 'ba'), records: 1, exit: 2, printRecords: false });
  const r = await c.run();
  return { c, r, recordsLine: keys.map((k) => lines(`${c.dir(`${k}-w1`)}/run.log`).some((l) => l.startsWith('Records: '))) };
};

const hookRuns = (cancelled: number) => `${Array.from({ length: 10 }, (_, i) => JSON.stringify({ arm: 'S2', kind: 'apply', sessionId: `h${i}`, hookCancels: i < cancelled ? { UserPromptSubmit: 1 } : {} })).join('\n')}\n`;
const H = async () => {
  const c = track(new Case({ name: 'H', keys1: ['ha'] }));
  c.knob('ha-w1', { fixture: KEY_FX(c, 'ha'), records: 1, exit: 2, printRecords: false });
  const planted = `${c.dir('zz-w1')}/run/runs.jsonl`;
  put(planted, hookRuns(1));
  const s = c.start();
  await until('the hold line', () => c.log().some((l) => l.startsWith('hold read: hold')));
  await sleep(4000);
  const launchedWhileHeld = c.launches().length;
  put(planted, hookRuns(0));
  const r = await s.done;
  return { c, r, launchedWhileHeld };
};

const BX = async () => {
  const c = track(new Case({ name: 'BX', keys1: ['xa'] }));
  c.knob('xa-w1', { fixture: KEY_FX(c, 'xa'), box: 'once', records: 1, exit: 2, printRecords: false });
  const r = await c.run();
  return { c, r, calls: lines(`${c.dir('xa-w1')}/launcher-calls.txt`).length };
};

const K = async () => {
  const c = track(new Case({ name: 'K', keys1: ['ka', 'kb'] }));
  const hold = { ka: c.hold('ka'), kb: c.hold('kb') };
  const body = (k: 'ka' | 'kb', extra: Knobs = {}): Knobs => ({ fixture: KEY_FX(c, k), release: hold[k], ...extra });
  c.knob('ka-w1', body('ka', { regrade: { exit: 1 } }));
  c.knob('kb-w1', body('kb'));
  const first = c.start();
  let firstEnded = false;
  void first.done.then(() => { firstEnded = true; });
  await until('both runners', () => c.runnerPids().length === 2 || firstEnded).catch(() => undefined);
  if (c.runnerPids().length < 2) {
    const launch = (n: string) => `${n} launch: ${[...lines(`${c.dir(n)}/launch.txt`), ...lines(`${c.dir(n)}/launch.err`)].join(' | ')}`;
    throw new Error(`K: pids.txt never held both runners; ${launch('ka-w1')}; ${launch('kb-w1')}; batch.log ends ${c.log().slice(-2).join(' | ')}`);
  }
  const second = await c.run();
  const batchLines = units(c, 'batch_lines', c.root).stdout.split('\n').filter((l) => l !== '');
  const runners = c.runnerPids();
  const launchers = ['ka-w1', 'kb-w1'].map((n) => c.launcherPid(n));
  const firstRun = await killBatch(c, first);
  const survived = { runners: runners.map(isAlive), launchers: launchers.map(isAlive) };
  const beating = [await heartbeat(c, 'ka-w1'), await heartbeat(c, 'kb-w1')];
  // The restart waits on both held runners, then on kb alone once ka is released, and ends only after kb's release.
  const from = c.log().length;
  const restart = c.start();
  const waitFor = (l: string) => l.startsWith('wait for ');
  const both = await lineOf(c, restart, from, 'a wait naming ka-w1 and kb-w1', (l) => waitFor(l) && l.includes('ka-w1') && l.includes('kb-w1'));
  put(hold.ka, '');
  const kbOnly = await lineOf(c, restart, Math.max(both + 1, from), 'a wait naming kb-w1 alone', (l) => waitFor(l) && l.includes('kb-w1') && !l.includes('ka-w1'));
  const midway = {
    both: both >= 0, kbOnly: kbOnly >= 0, kaDone: lines(`${c.dir('ka-w1')}/run.log`).some((l) => l.startsWith('Records: ')),
    running: restart.child.exitCode === null && restart.child.signalCode === null, markers: c.markers(), end: fs.existsSync(`${c.root}/batch1/END`),
  };
  put(hold.kb, '');
  const third = await restart.done;
  c.knob('ka-w1', body('ka'));
  const fourth = await c.run();
  return { c, first: firstRun, second, third, fourth, survived, batchLines, runners, beating, midway };
};

const L = async () => {
  const c = track(new Case({ name: 'L', keys1: ['la', 'lb', 'lc'] }));
  c.knob('la-w1', { fixture: KEY_FX(c, 'la'), pins: 'once', regrade: { exit: 1 } });
  const [releaseB, releaseC] = [c.hold('lb'), c.hold('lc')];
  c.knob('lb-w1', { fixture: KEY_FX(c, 'lb'), release: releaseB });
  c.knob('lc-w1', { fixture: KEY_FX(c, 'lc'), exitRelease: releaseC });
  const s = c.start();
  await until('the lb runner', () => c.runnerPids().length === 2 && c.log().some((l) => l.startsWith('launch lb-w1 pid ')));
  c.kill(c.launcherPid('lb-w1'));
  put(releaseB, '');
  const first = await s.done;
  const exitFiles = ['la', 'lb', 'lc'].map((k) => fs.existsSync(`${c.dir(`${k}-w1`)}/run/exit.txt`));
  const second = await startHeld(c, 'lc-w1', releaseC);
  return { c, first, second, exitFiles, lcExit: lines(`${c.dir('lc-w1')}/run/exit.txt`) };
};

const G = async () => {
  const c = track(new Case({ name: 'G', keys1: ['ga', 'gb'], width: 1 }));
  const release = c.hold('ga');
  c.knob('ga-w1', { fixture: KEY_FX(c, 'ga'), hang: true, beatUntil: release, regrade: { exit: 1 } });
  c.knob('gb-w1', { fixture: KEY_FX(c, 'gb') });
  const r = await releaseOn(c, c.start(), 0, 'launch ', 'gb-w1', release);
  return { c, r, hangPid: c.runnerPids()[0] };
};

const G2 = async () => {
  const c = track(new Case({ name: 'G2', keys1: ['gc'] }));
  const release = c.hold('gc');
  c.knob('gc-w1', { fixture: KEY_FX(c, 'gc'), hang: true, beatUntil: release, regrade: { exit: 1 } });
  const s = c.start();
  await until('the Records line', () => lines(`${c.dir('gc-w1')}/run.log`).some((l) => l.startsWith('Records: ')));
  await killBatch(c, s);
  put(release, '');
  const stillAlive = isAlive(c.runnerPids()[0]);
  const r = await c.run();
  return { c, r, stillAlive, hangPid: c.runnerPids()[0] };
};

const T = async () => {
  const c = track(new Case({ name: 'T', keys1: ['ta'] }));
  c.knob('default', { fixture: KEY_FX(c, 'ta'), records: 1, exit: 2, printRecords: false });
  const calls: Run[] = [];
  for (let i = 0; i < 4; i++) calls.push(await c.run());
  return { c, calls };
};

const D = async () => {
  const keys = ['d1', 'd2', 'df', 'dn', 'dl'];
  const c = track(new Case({ name: 'D', keys1: keys }));
  const fx = Object.fromEntries(keys.map((k) => [k, KEY_FX(c, k)]));
  await c.plant('d1-w1', fx.d1);
  await c.plant('d2-w1', fx.d2);
  await c.plant('df-w1', fx.df, 1);
  const release = c.hold('dl');
  const dl = liveRunner(c, `${c.dir('dl-w1')}/run`, `${c.dir('dl-w1')}/run`, { fixture: fx.dl, release });
  c.knob('df-w1-a2', { fixture: fx.df, records: 1, exit: 2, printRecords: false });
  c.knob('dn-w1', { fixture: fx.dn, records: 1, exit: 2, printRecords: false });
  const r = await startHeld(c, 'dl-w1', release);
  return { c, r, dl };
};

const Z = async () => {
  const c = track(new Case({ name: 'Z', keys1: ['za'] }));
  await c.plant('za-w1', KEY_FX(c, 'za', [1, 2, 3], { leaks: [2] }));
  put(`${c.dir('za-w1')}/leaks.json`, '{"schema": "z0-lea');
  c.knob('za-e2', { fixture: KEY_FX(c, 'za', [2], { tag: 'r' }), records: 1, exit: 2, printRecords: false });
  const r = await c.run();
  return { c, r, leaks: json(`${c.dir('za-w1')}/leaks.json`) };
};

const R = async () => {
  const c = track(new Case({ name: 'R', b: 'raise', keys1: ['ra'], keys2: ['rb'] }));
  put(`${c.root}/raise/max-seed.json`, '{"maxSeed": 5, "count": 8}');
  put(`${c.root}/seed-rule.json`, '{"schema": "z0-seed-rule/2"}');
  c.knob('ra-w2', { fixture: KEY_FX(c, 'ra', [4, 5], { leaks: [4] }) });
  c.knob('rb-w2', { fixture: KEY_FX(c, 'rb', [4, 5]) });
  c.knob('ra-e4', { fixture: KEY_FX(c, 'ra', [4], { tag: 'r' }), records: 1, exit: 2, printRecords: false });
  const r = await c.run();
  return { c, r };
};

const RN = async () => {
  const c = track(new Case({ name: 'RN', b: 'raise', keys1: ['ra'], keys2: ['rb'] }));
  const missing = await c.run();
  put(`${c.root}/raise/max-seed.json`, '{"maxSeed": 3, "count": 2}');
  put(`${c.root}/seed-rule.json`, '{"schema": "z0-seed-rule/2"}\n');
  const none = await c.run();
  const again = await c.run();
  return { c, missing, none, again };
};

const Pq = async () => {
  const keys = ['q145', 'q14'];
  const c = track(new Case({ name: 'P', keys1: keys }));
  const fx = { w: KEY_FX(c, 'q145', [1, 2, 3], { leaks: [1] }), e: KEY_FX(c, 'q145', [1], { tag: 'r' }), k: KEY_FX(c, 'q14') };
  for (const [name, fixture] of [['q145-w1', fx.w], ['q145-e1', fx.e], ['q14-w1', fx.k]] as const) {
    c.g5Done(await c.plant(name, fixture));
  }
  const first = await c.run();
  const outputs = ['batch1/drop-list.json', 'batch1/grading.json', 'batch1/read-set.txt', 'merged/batch1/q145-w1/merge.json', 'merged/batch1/q145-w1/runs.jsonl', 'q145-w1/off-pin.json', 'q145-e1/off-pin.json', 'q14-w1/off-pin.json']
    .map((f) => (f.startsWith('batch1/') || f.startsWith('merged/') ? `${c.root}/${f}` : `${c.root}/batch1/${f}`));
  const bytes = () => outputs.map((f) => fs.readFileSync(f).toString('base64'));
  const written = bytes();
  const scale = read(`${c.root}/scale.json`);
  const scaleTime = fs.statSync(`${c.root}/scale.json`).mtimeMs;
  const end = read(`${c.root}/batch1/END`);
  fs.rmSync(`${c.root}/batch1/END`);
  put(`${c.root}/batch1/END.tmp-9`, 'BATCH 1 DO');
  const second = await c.run();
  const rewritten = { same: bytes().every((b, i) => b === written[i]), end: read(`${c.root}/batch1/END`), tmp: fs.existsSync(`${c.root}/batch1/END.tmp-9`), scaleSame: read(`${c.root}/scale.json`) === scale && fs.statSync(`${c.root}/scale.json`).mtimeMs === scaleTime };
  const third = await c.run();
  return { c, first, second, third, end, rewritten, outputs, ledgerLine: cmds(c, 'z0-ledger')[0] };
};

const Pf = async () => {
  const c = track(new Case({ name: 'PF', keys1: ['q145', 'q14'] }));
  c.g5Done(await c.plant('q145-w1', KEY_FX(c, 'q145')));
  c.g5Done(await c.plant('q14-w1', KEY_FX(c, 'q14')));
  fs.rmSync(`${c.dir('q14-w1')}/run/raw`, { recursive: true });
  const r = await c.run();
  return { c, r };
};

const wcase = async (name: string, knob: Knobs) => {
  const c = track(new Case({ name, keys1: ['wa'] }));
  await c.plant('wa-w1', KEY_FX(c, 'wa'));
  c.knob('wa-w1', knob);
  return c;
};
const stub = (c: Case, call: string): { start: number; end: number; lockSeen: boolean } => json(`${c.dir('wa-w1')}/g5-${call}.stub.json`);
const callsOf = (c: Case, call: string) => lines(`${c.root}/batch1/regrade-pids.txt`).filter((l) => l.endsWith(` ${call}`)).length;

const W1 = async () => {
  const c = await wcase('W1', { regrade: { durationS: 20, lock: true } });
  return { c, r: await c.run() };
};
const W2 = async () => {
  const c = await wcase('W2', { regrade: { hangOnce: true } });
  const s = c.start();
  await until('the held lock', () => fs.existsSync(`${c.dir('wa-w1')}/run/g5/regrade.lock`) && lines(`${c.root}/batch1/regrade-pids.txt`).length === 1);
  const pid = Number(lines(`${c.root}/batch1/regrade-pids.txt`)[0].split(' ')[1]);
  c.kill(pid);
  const first = await s.done;
  const second = await c.run();
  return { c, first, second, pid };
};
const W3 = async () => {
  const c = await wcase('W3', {});
  const release = c.hold('regrade');
  c.knob('wa-w1', { regrade: { release } });
  const from = c.log().length;
  const s = c.start();
  // The launcher writes its pid file before Start-Process, so the kill waits for the stub's regrade-pids.txt line.
  await until('the regrade stub', () => callsOf(c, 'regrade') === 1);
  c.kill(Number(read(`${c.dir('wa-w1')}/g5-regrade.launcher.pid`).trim()));
  return { c, r: await releaseOn(c, s, from, 'wait for ', 'wa-w1', release) };
};
const W4 = async () => {
  const c = await wcase('W4', { 'reader-draw': { keyNoLine: true } });
  const keyFile = `${c.dir('wa-w1')}/run/g5/sealed/reader-r1.key.json`;
  const first = await c.run();
  const keyBefore = fs.existsSync(keyFile);
  c.knob('wa-w1', {});
  const second = await c.run();
  c.fillLabels(['wa-w1']);
  const keyText = '{"pairs": [{"file": "p1", "which": "first", "verdict": "pass"';
  put(keyFile, keyText);
  c.knob('wa-w1', { 'reader-score': { real: true } });
  const third = await c.run();
  return { c, first, second, third, keyBefore, keyText, keyAfter: read(keyFile) };
};
const W5a = async () => {
  const c = await wcase('W5a', { regrade: { errorRows: { times: 1, rows: 2 } } });
  return { c, r: await c.run() };
};
const W5b = async () => {
  const c = await wcase('W5b', { regrade: { errorRows: { times: 9, rows: 2 } } });
  return { c, r: await c.run() };
};

const S = async () => {
  const c = track(new Case({ name: 'S', keys1: ['sa', 'sb'] }));
  const root = c.root;
  const out = (n: string) => `${c.dir(n)}/run`;
  const a2 = liveRunner(c, out('sa-w1-a2'));
  const upper = liveRunner(c, out('sb-w1'), `${root.toUpperCase().replace(/\//g, '\\')}\\batch1\\sb-w1\\run`);
  const wrapperFolder = c.dir('sc-w1');
  spawn(gitBash(process.env, []), ['-c', `sleep 60 # ${wrapperFolder} s4-run.ps1`], { windowsHide: true, stdio: 'ignore', cwd: c.base });
  spawn('powershell', ['-NoProfile', '-Command', `Start-Sleep 60; '${wrapperFolder} s4-run.ps1'`], { windowsHide: true, stdio: 'ignore', cwd: c.base });
  await sleep(1500);
  const alive = (folder: string) => units(c, 'unit_alive', folder).status;
  return {
    c, a2, upper,
    plain: alive(c.dir('sa-w1')), retry: alive(c.dir('sa-w1-a2')), mixedCase: alive(c.dir('sb-w1')), wrapper: alive(wrapperFolder),
    under: units(c, 'root_lines', root).stdout, dry: units(c, 'root_lines', 'C:/z0-runs/r4').stdout, usage: spawnSync(gitBash(process.env, []), [`${c.scored}/s4-units.sh`], { encoding: 'utf8', env: c.env(), cwd: c.base }),
  };
};

const Q = async () => {
  const c = track(new Case({ name: 'Q', keys1: ['qa1'], admit: false }));
  const bashRun = (args: string[], env: Record<string, string> = {}) => spawnSync(gitBash(process.env, []), [`${c.scored}/s4-batch.sh`, ...args], { env: c.env(env), encoding: 'utf8', cwd: c.base });
  const ok = [c.n, CHECKOUT, c.root];
  const fake = `${c.base}/knobs.json`;
  put(fake, '{}');
  const noAdmit = bashRun(ok);
  put(`${c.root}/batch1/ADMITTED`, 'x\n');
  put(`${c.dir('qa1-w1')}/run/runs.regraded.jsonl`, '');
  const regraded = bashRun(ok);
  const slashed = bashRun([c.n, CHECKOUT, `${c.root}/`]);
  const posix = bashRun([c.n, CHECKOUT, `/${c.root[0].toLowerCase()}${c.root.slice(2)}`]);
  const usage = ['--poll', '--poll abc', '--poll 0', '--fake', '--fake nope.json', '--bogus 1'].map((a) => bashRun([...ok, ...a.split(' ')]));
  const badN = bashRun(['9', CHECKOUT, c.root]);
  const emptyFake = bashRun([...ok, '--fake', '']);
  fs.rmSync(`${c.root}/DRYRUN`);
  const notDry = bashRun(ok);
  // Z0_REPOS_FILE is unset here so its own refusal does not speak first.
  const notDryBox = bashRun(ok, { Z0_REPOS_FILE: '', Z0_BOX_CHECK: fake });
  put(`${c.root}/DRYRUN`, '');
  // A single quote cannot reach the script through bash.exe's own argument parsing, so the file name here holds a space; the script's pattern covers both.
  const quoted = `${c.base}/fake knobs.json`;
  put(quoted, '{}');
  const refused = {
    relative: bashRun([c.n, CHECKOUT, 'rel/root']),
    root: bashRun([c.n, CHECKOUT, 'C:/a b/root']),
    checkout: bashRun([c.n, 'C:/a b/checkout', c.root]),
    fake: bashRun([...ok, '--fake', quoted]),
    grace: bashRun(ok, { Z0_GRACE_S: 'abc' }),
    boxFile: bashRun(ok, { Z0_BOX_CHECK: `${c.base}/nope.sh` }),
    boxSpace: bashRun(ok, { Z0_BOX_CHECK: quoted }),
  };
  const launcher = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', `${c.scored}/s4-run.ps1`, '-Checkout', CHECKOUT, '-Root', c.root, '-Batch', '1', '-Key', 'qa1', '-Folder', c.dir('qa1-w1')], { encoding: 'utf8', input: '', cwd: c.base });
  const regradeLauncher = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', `${c.scored}/s4-regrade.ps1`, '-Checkout', CHECKOUT, '-Root', c.root, '-Key', 'qa1', '-Folder', c.dir('qa1-w1'), '-Call', 'regrade'], { encoding: 'utf8', input: '', cwd: c.base });
  return { c, noAdmit, regraded, slashed, posix, usage, badN, emptyFake, notDry, notDryBox, quoted, refused, launcher, regradeLauncher, launchedAny: fs.existsSync(`${c.dir('qa1-w1')}/launcher-args.json`), fake };
};

/** A dry batch run with Z0_BOX_CHECK set: its launch and its G5 regrade calls are the launcher commands it makes. */
const Bx = async () => {
  const c = track(new Case({ name: 'Bx', keys1: ['bx'] }));
  c.knob('bx-w1', { fixture: KEY_FX(c, 'bx') });
  const box = `${c.base}/box-ok.sh`;
  put(box, '#!/usr/bin/env bash\nexit 0\n');
  return { c, box, r: await c.run([], { Z0_BOX_CHECK: box }) };
};

const TWO = ['q145', 'q14'];
/** A case of the two keys with every unit folder finished and every G5 call done, so a batch on it runs only its checks and its end phase. */
async function finished(name: string) {
  const c = track(new Case({ name, keys1: TWO }));
  for (const k of TWO) c.g5Done(await c.plant(`${k}-w1`, KEY_FX(c, k)));
  return c;
}

/** A write that cannot land stops the batch with a named line: a directory sits where END, and where a marker, belongs. */
const E = async () => {
  const end = await finished('E1');
  fs.mkdirSync(`${end.root}/batch1/END`, { recursive: true });
  const endRun = await end.run();
  const mark = track(new Case({ name: 'E2', keys1: TWO }));
  await mark.plant('q145-w1', KEY_FX(mark, 'q145'));
  fs.mkdirSync(`${mark.dir('done')}/q145-w1`, { recursive: true });
  return { end, endRun, mark, markRun: await mark.run() };
};

/** A resume over completed G5 calls reads their sealed files: one folder of each kind of damage. */
const Sl = async () => {
  const damaged = async (name: string, damage: (sealed: string) => void) => {
    const c = await finished(name);
    damage(`${c.dir('q145-w1')}/run/g5/sealed`);
    return { c, r: await c.run() };
  };
  return {
    key: await damaged('Sl1', (s) => put(`${s}/stored.key.json`, '{"units": ["u1", ')),
    score: await damaged('Sl2', (s) => put(`${s}/stored.score.json`, '{"labels": {')),
    missing: await damaged('Sl3', (s) => fs.rmSync(`${s}/reader-r1.score.json`)),
  };
};

/** Score calls with no record and a torn temp beside each missing score file: the temp is no record, so both calls run and write the files whole. */
const Pt = async () => {
  const c = await finished('Pt');
  const dir = c.dir('q145-w1');
  const sealed = `${dir}/run/g5/sealed`;
  for (const f of ['reader-r1.score.json', 'stored.score.json']) fs.rmSync(`${sealed}/${f}`);
  for (const call of ['reader-score', 'stored-score', 'grading']) fs.rmSync(`${dir}/g5-${call}.log`);
  put(`${sealed}/reader-r1.score.json.tmp-5`, '{"round": 1, "n"');
  put(`${sealed}/stored.score.json.tmp-5`, '{"labels"');
  return { c, r: await c.run(), sealed };
};

/** A runner that wrote every planned record with no Records: line and exit 0 is done by its records. */
const Pb = async () => {
  const c = track(new Case({ name: 'Pb', keys1: ['pa'] }));
  c.knob('pa-w1', { fixture: KEY_FX(c, 'pa'), printRecords: false, exit: 0, endMs: 3000, regrade: { exit: 1 } });
  return { c, r: await c.run() };
};

/** A runner one record short that exits 0 is failed, and its retry is the next attempt folder. */
const Pr = async () => {
  const c = track(new Case({ name: 'Pr', keys1: ['pc'] }));
  const fx = KEY_FX(c, 'pc');
  c.knob('pc-w1', { fixture: fx, records: c.size(fx) - 1, printRecords: false, exit: 0 });
  c.knob('pc-w1-a2', { fixture: fx, regrade: { exit: 1 } });
  const first = await c.run();
  return { c, first, second: await c.run() };
};

/** The launcher killed after Start-Process and before its pids.txt line, then the batch killed and restarted. */
const Pd = async () => {
  const c = track(new Case({ name: 'Pd', keys1: ['pb'] }));
  const release = c.hold('pb');
  c.knob('pb-w1', { fixture: KEY_FX(c, 'pb'), pidsDelayS: 60, release, regrade: { exit: 1 } });
  const s = c.start();
  await until('the runner log', () => fs.existsSync(`${c.dir('pb-w1')}/run.log`) && c.log().some((l) => l.startsWith('launch pb-w1 pid ')));
  await sleep(1500);
  const launcher = c.launcherPid('pb-w1');
  c.kill(launcher);
  await sleep(1000);
  await killBatch(c, s);
  const pidsLines = c.runnerPids().length;
  return { c, pidsLines, r: await startHeld(c, 'pb-w1', release), launcher };
};

/** A launch that gives no pid: a directory sits where start.out goes, so the shell cannot open it, and a launch.txt of an earlier launch is in the folder. */
const Ql = async () => {
  const c = track(new Case({ name: 'Ql', keys1: ['xa'] }));
  c.knob('xa-w1', { fixture: KEY_FX(c, 'xa') });
  put(`${c.dir('xa-w1')}/launch.txt`, 'box check failed: left by an earlier launch\n');
  fs.mkdirSync(`${c.dir('xa-w1')}/start.out`, { recursive: true });
  return { c, r: await c.run() };
};

/** A checkout whose z0-unit-record refuses `arms rerun` (a first run's plan that lost a seed between z0-leaks and the launch) over the real CLIs the batch calls before it. */
const Zr = async () => {
  const c = track(new Case({ name: 'Zr', keys1: ['za'] }));
  await c.plant('za-w1', KEY_FX(c, 'za', [1, 2, 3], { leaks: [2] }));
  const co = `${c.base}/co`;
  for (const cli of ['z0-leaks', 'z0-hookhold', 'z0-unit-record']) {
    const refuse = cli === 'z0-unit-record' ? "if (process.argv[2] === 'arms' && process.argv[3] === 'rerun') { console.error('arms refused on purpose'); process.exit(1); }\n" : '';
    put(`${co}/scripts/token-eval/${cli}.mjs`, `import { spawnSync } from 'node:child_process';\n${refuse}process.exit(spawnSync(process.execPath, [${JSON.stringify(`${CHECKOUT}/scripts/token-eval/${cli}.mjs`)}, ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1);\n`);
  }
  return { c, r: await c.start([], {}, c.root, c.n, co).done };
};

/* -------------------------------------------------------------------------------------------- the scenarios run together */

const sem = (() => {
  let free = Number(process.env.Z0_BATCH_LANES ?? 4);
  const waiting: (() => void)[] = [];
  return {
    async take() { if (free > 0) { free -= 1; return; } await new Promise<void>((resolve) => waiting.push(resolve)); },
    give() { const next = waiting.shift(); if (next) next(); else free += 1; },
  };
})();
/** One scenario, started once under the lane cap; a failure reaches the cases that read it, not an unhandled rejection. */
function lazy<T>(fn: () => Promise<T>) {
  let started: Promise<T> | undefined;
  return {
    start() {
      started ??= (async () => { await sem.take(); try { return await fn(); } finally { sem.give(); } })();
      started.catch(() => undefined);
    },
    get: () => started!,
    pending: (): Promise<unknown>[] => (started ? [started] : []),
  };
}
const runs = { A: lazy(A), B: lazy(B), H: lazy(H), BX: lazy(BX), K: lazy(K), L: lazy(L), G: lazy(G), G2: lazy(G2), T: lazy(T), D: lazy(D), Z: lazy(Z), R: lazy(R), RN: lazy(RN), Pq: lazy(Pq), Pf: lazy(Pf),
  W1: lazy(W1), W2: lazy(W2), W3: lazy(W3), W4: lazy(W4), W5a: lazy(W5a), W5b: lazy(W5b), S: lazy(S), Q: lazy(Q),
  E: lazy(E), Bx: lazy(Bx), Sl: lazy(Sl), Pt: lazy(Pt), Pb: lazy(Pb), Pr: lazy(Pr), Pd: lazy(Pd), Ql: lazy(Ql), Zr: lazy(Zr) };
const only = process.env.Z0_BATCH_ONLY?.split(',');

describe.skipIf(!win)('s4-batch.sh over stub launchers and stub runners (needs Windows processes, PowerShell 5.1 and Git Bash)', () => {
  const started = Date.now();
  let keep: string | undefined;
  beforeAll(() => {
    // A refused keep folder fails the run before any scenario starts, and leaves keep unset so teardown copies nothing.
    keep = keepDir(process.env.Z0_BATCH_KEEP);
    for (const [k, s] of Object.entries(runs)) if (!only || only.includes(k)) s.start();
  });
  afterAll(async () => {
    // Teardown releases every hold and kills every case's processes before it waits on any scenario, and each wait has a bound.
    // Every step's failure joins one list, thrown at the end, so no failed step hides the ones after it.
    const errors: string[] = [];
    const attempt = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await stopCases(cases, 60_000).catch((e: Error) => errors.push(`the first teardown stop: ${e.message}`));
    const pending = Promise.allSettled(Object.values(runs).flatMap((s) => s.pending()));
    await within(pending, 60_000, 'the scenarios to settle once teardown stopped their processes').catch((e: Error) => errors.push(e.message));
    // With no second read, which cases still hold processes is unknown, so no case folder is removed.
    const left = await stopCases(cases, 30_000).catch((e: Error) => { errors.push(`the second teardown stop: ${e.message}`); });
    if (left) for (const [base, pids] of left) errors.push(`${base} still has pids ${pids.join(' ')} after teardown`);
    // Global teardown removes the run's temp root (_real-store-guard.ts), so a diagnosis run copies each case folder, batch log and all, out first.
    const into = keep;
    for (const c of cases) {
      if (into) attempt(`the copy of ${c.base} to ${into}`, () => fs.cpSync(c.base, path.join(into, path.basename(c.base)), { recursive: true }));
      if (left && !left.has(c.base)) attempt(`the removal of ${c.base}`, () => c.remove());
    }
    const time = process.env.Z0_BATCH_TIME;
    if (time) attempt('the time file', () => fs.writeFileSync(time, `${Math.round((Date.now() - started) / 1000)} s\n`));
    if (errors.length > 0) throw new Error(errors.join('; '));
  }, 240_000);
  const last = (r: Run) => r.last;

  describe('the start', () => {
    it('a start with no <b>/ADMITTED exits 1 and launches none', async () => {
      const { noAdmit, c } = await runs.Q.get();
      expect(noAdmit.status).toBe(1);
      expect(noAdmit.stdout.trim()).toBe('BATCH 1: no ADMITTED; run it through s4-drive.sh');
      expect(fs.existsSync(`${c.dir('qa1-w1')}/launcher-args.json`)).toBe(false);
    });

    it('a runs.regraded.jsonl in a folder stops it, naming the file', async () => {
      const { regraded, c, launchedAny } = await runs.Q.get();
      expect(regraded.status).toBe(1);
      expect(regraded.stdout.trim()).toBe(`BATCH 1: ${c.dir('qa1-w1')}/run/runs.regraded.jsonl exists; round 4 never reads runs.regraded.jsonl`);
      expect(launchedAny).toBe(false);
    });

    it('a root given with a trailing slash or as /c/... exits 1 naming the form it needs [JO3]', async () => {
      const { slashed, posix, c } = await runs.Q.get();
      expect([slashed.status, posix.status]).toEqual([1, 1]);
      expect(slashed.stdout.trim()).toBe(`BATCH 1: root ${c.root}/ must be written as ${c.root}`);
      expect(posix.stdout.trim()).toBe(`BATCH 1: root /${c.root[0].toLowerCase()}${c.root.slice(2)} must be written as ${c.root}`);
    });

    it('a bad N, a trailing flag, an empty or non-integer --poll and a missing --fake file exit 1 with the usage', async () => {
      const { usage, badN, emptyFake } = await runs.Q.get();
      for (const r of [...usage, badN, emptyFake]) {
        expect(r.status).toBe(1);
        expect(r.stdout.trim()).toBe('usage: s4-batch.sh <1|2|raise> <checkout> <root> [--poll <s>] [--fake <knobs>]');
      }
    });

    it('Z0_REPOS_FILE on a root with no DRYRUN file exits 1 naming the variable, and on a dry root the batch logs the repos file it used [W3-4]', async () => {
      const { notDry, c } = await runs.Q.get();
      expect(notDry.status).toBe(1);
      expect(notDry.stdout.trim()).toBe(`BATCH 1: Z0_REPOS_FILE is set, but ${c.root} holds no DRYRUN file; only a dry root may use it`);
      const b = await runs.Pb.get();
      expect(b.c.log().filter((l) => l.startsWith('repos file '))).toEqual([`repos file ${b.c.base}/repos.json`]);
    });

    it('Z0_BOX_CHECK on a root with no DRYRUN file exits 1 naming the variable; on a dry root a missing file or a path with a space exits 1 too', async () => {
      const { notDryBox, refused, c, quoted } = await runs.Q.get();
      expect([notDryBox.status, notDryBox.stdout.trim()]).toEqual([1, `BATCH 1: Z0_BOX_CHECK is set, but ${c.root} holds no DRYRUN file; only a dry root may use it`]);
      expect([refused.boxFile.status, refused.boxFile.stdout.trim()]).toEqual([1, `BATCH 1: Z0_BOX_CHECK ${c.base}/nope.sh is not a file`]);
      expect([refused.boxSpace.status, refused.boxSpace.stdout.trim()]).toEqual([1, `BATCH 1: Z0_BOX_CHECK ${quoted} holds a space or a single quote, which the launcher command cannot carry`]);
    });

    it('Z0_BOX_CHECK on a dry root reaches the launcher of every unit and every G5 regrade call, and no call without it', async () => {
      const { c, box, r } = await runs.Bx.get();
      expect(r.code, r.out).toBe(7);
      expect(c.flags('bx-w1').BoxCheck).toBe(box);
      const calls = ['regrade', 'reader-draw', 'stored-draw'].map((call) => json(`${c.dir('bx-w1')}/g5-${call}.launcher.json`));
      expect(calls.map((x) => x.BoxCheck)).toEqual([box, box, box]);
      const plain = await runs.Pb.get();
      expect(plain.c.flags('pa-w1')).not.toHaveProperty('BoxCheck');
    });

    it('a relative root exits 1 asking for an absolute one, so two spellings of one root cannot both run', async () => {
      const { refused } = await runs.Q.get();
      expect(refused.relative.status).toBe(1);
      expect(refused.relative.stdout.trim()).toBe('BATCH 1: root rel/root must be an absolute path such as C:/z0-runs/r4');
    });

    it('a root, a checkout or a --fake file holding a space or a single quote exits 1 with a named line before any launcher command is built', async () => {
      const { refused, quoted } = await runs.Q.get();
      const carry = 'holds a space or a single quote, which the launcher command cannot carry';
      expect([refused.root.status, refused.checkout.status, refused.fake.status]).toEqual([1, 1, 1]);
      expect(refused.root.stdout.trim()).toBe(`BATCH 1: root C:/a b/root ${carry}`);
      expect(refused.checkout.stdout.trim()).toBe(`BATCH 1: checkout C:/a b/checkout ${carry}`);
      expect(refused.fake.stdout.trim()).toBe(`BATCH 1: --fake ${quoted} ${carry}`);
    });

    it('a Z0_GRACE_S that is not a whole number exits 1 naming the variable, since a hung runner would never be stopped', async () => {
      const { refused } = await runs.Q.get();
      expect(refused.grace.status).toBe(1);
      expect(refused.grace.stdout.trim()).toBe('BATCH 1: Z0_GRACE_S abc must be a whole number of seconds');
    });

    it('the stub launchers refuse a call without -Toolchain', async () => {
      const { launcher, regradeLauncher } = await runs.Q.get();
      expect(launcher.status).not.toBe(0);
      expect(regradeLauncher.status).not.toBe(0);
    });

    it('with maxSeed 3, raise writes NONE holding the rule\'s sha256, starts none, and a rerun prints the same line [KO3]', async () => {
      const { missing, none, again, c } = await runs.RN.get();
      expect(missing).toMatchObject({ code: 1, out: 'BATCH raise: no raise/max-seed.json; run step 6 through s4-drive.sh' });
      expect(none).toMatchObject({ code: 0, out: 'BATCH raise DONE: 0 runs' });
      expect(read(`${c.root}/raise/NONE`)).toBe(`${sha(`${c.root}/seed-rule.json`)}\n`);
      expect(read(`${c.root}/raise/END`)).toBe('BATCH raise DONE: 0 runs\n');
      expect(again).toMatchObject({ code: 0, out: 'BATCH raise DONE: 0 runs' });
      expect(c.launches()).toEqual([]);
    });
  });

  describe('phase 0 and the hold', () => {
    it('hold launches no runner until ok [R102]', async () => {
      const { c, launchedWhileHeld } = await runs.H.get();
      expect(launchedWhileHeld).toBe(0);
      expect(c.log().filter((l) => l.startsWith('hold read: '))).toEqual(['hold read: hold 1 of 10', 'hold read: ok 0 of 10']);
      expect(c.launches()).toEqual(['ha-w1']);
    });

    it('a stub runner exit 2 ends phase 0 with BATCH 1 FAILED: <k> runner exit 2 once the phase\'s other units end [O10, GO1]', async () => {
      const { c, r } = await runs.H.get();
      expect(r).toMatchObject({ code: 3, last: 'BATCH 1 FAILED: ha-w1 runner exit 2' });
      const b = await runs.B.get();
      expect(b.r).toMatchObject({ code: 3, out: 'BATCH 1 FAILED: ba-w1 runner exit 2' });
      expect(b.recordsLine).toEqual([false, true, true, true]);
      expect(c.launches()).toEqual(['ha-w1']);
    });

    it('with width 2 and four keys, a stub that fails first leaves the two queued keys launched and finished in phase 0 [KO3]', async () => {
      const { c, r } = await runs.B.get();
      expect(c.launches()).toEqual(['ba-w1', 'bb-w1', 'bc-w1', 'bd-w1']);
      expect(r.out.split('\n')).toHaveLength(1);
      expect(fs.existsSync(c.dir('ba-w1-a2'))).toBe(false);
    });

    it('a box check fail retries after the wait, with no failure line [R102]', async () => {
      const { c, r, calls } = await runs.BX.get();
      expect(c.log().filter((l) => l.startsWith('box check failed for xa-w1, waiting 2s'))).toHaveLength(1);
      expect(c.launches()).toEqual(['xa-w1', 'xa-w1']);
      expect(calls).toBe(2);
      expect(r).toMatchObject({ code: 3, out: 'BATCH 1 FAILED: xa-w1 runner exit 2' });
    });

    it('every launch passes its flags end to end: the toolchain from the repos file, the arms and the seeds', async () => {
      const { c } = await runs.A.get();
      expect(c.flags('q145-w1')).toMatchObject({ Checkout: CHECKOUT, Root: c.root, Batch: '1', Key: 'q145', Toolchain: 'node', Folder: c.dir('q145-w1'), Arms: 'O1,S0,S1,S2,S4,S5', Seeds: '3' });
      expect(c.flags('q14-w1')).toMatchObject({ Key: 'q14', Toolchain: 'python', Arms: 'O1,S0,S1,S2,S4,S5', Seeds: '3' });
      expect(c.flags('q14-w1')).not.toHaveProperty('Retry');
      const { c: raise } = await runs.R.get();
      expect(raise.flags('ra-w2')).toMatchObject({ Batch: 'raise', Arms: 'O1,S1,S2,S5', SeedRule: `${raise.root}/seed-rule.json`, MaxSeed: '5' });
      expect(raise.flags('ra-w2')).not.toHaveProperty('Seeds');
    });
  });

  describe('retries, leak reruns and the phases', () => {
    it('a stub runner that writes one record and then exits 1: the step again retries it in <k>-w1-a2/ and done/<k> names it [YP2-1]', async () => {
      const { c, calls } = await runs.A.get();
      expect(last(calls[0])).toBe('BATCH 1 FAILED: q14-w1 runner exit 1');
      expect(calls[0].code).toBe(3);
      expect(c.flags('q14-w1-a2')).toMatchObject({ Retry: '2', Folder: c.dir('q14-w1-a2') });
      expect(c.marker('q14')).toBe('q14-w1-a2\n');
      expect(c.marker('q14-w1')).toBe('q14-w1-a2\n');
    });

    it('leaks at seeds 1 and 3 rerun with that seed\'s arms in the next phase, after the first runs ended [R100, UP1-1]', async () => {
      const { c, calls } = await runs.A.get();
      expect(c.flags('q145-e1')).toMatchObject({ OnlySeed: '1', Arms: 'O1,S0,S1,S2,S4,S5', Folder: c.dir('q145-e1') });
      expect(c.flags('q145-e3')).toMatchObject({ OnlySeed: '3', Arms: 'O1,S1,S2,S5' });
      expect(c.flags('q145-e1')).not.toHaveProperty('SeedRule');
      expect(at(c, 'BATCH 1 FAILED: q14-w1')).toBeGreaterThan(-1);
      expect(at(c, 'launch q145-e1')).toBeGreaterThan(at(c, 'BATCH 1 FAILED: q14-w1'));
      expect(c.launches().slice(0, 2)).toEqual(['q145-w1', 'q14-w1']);
      expect(last(calls[1])).toBe('BATCH 1 FAILED: q145-e3 runner exit 1');
    });

    it('a leak rerun stub that writes one record and then exits 1: the next phase retries it in <k>-e<s>-a2/, writes done/<k>-e<s> naming it and only then done/<k> [GO3, ZP2-1]', async () => {
      const { c } = await runs.A.get();
      expect(c.flags('q145-e3-a2')).toMatchObject({ Retry: '2', OnlySeed: '3', Arms: 'O1,S1,S2,S5' });
      expect(c.marker('q145-e3')).toBe('q145-e3-a2\n');
      const order = ['marker q145-w1 ', 'marker q145-e1 ', 'marker q145-e3 ', 'marker q145 '].map((p) => at(c, p));
      expect(order.every((i) => i > -1)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('the leaks.json of a first run is rewritten until done/<k> exists: a partial file is run again before any leak rerun', async () => {
      const { c, leaks, r } = await runs.Z.get();
      expect(leaks.leaks).toEqual([{ sequence: 'rn-za', seed: 2 }]);
      expect(at(c, 'cmd z0-leaks ')).toBeGreaterThan(-1);
      expect(at(c, 'launch za-e2')).toBeGreaterThan(at(c, 'cmd z0-leaks '));
      expect(fs.existsSync(`${c.root}/batch1/done/za`)).toBe(false);
      expect(r).toMatchObject({ code: 3, out: 'BATCH 1 FAILED: za-e2 runner exit 2' });
    });

    it('a raise leak at seed 4 reruns with the rule arms, -SeedRule and -MaxSeed in the next phase', async () => {
      const { c, r } = await runs.R.get();
      expect(c.flags('ra-e4')).toMatchObject({ Batch: 'raise', OnlySeed: '4', Arms: 'O1,S1,S2,S5', SeedRule: `${c.root}/seed-rule.json`, MaxSeed: '5' });
      expect(c.launches().slice(0, 2)).toEqual(['ra-w2', 'rb-w2']);
      expect(r).toMatchObject({ code: 3, out: 'BATCH raise FAILED: ra-e4 runner exit 2' });
    });

    it('a start with two keys done, one failed, one never launched and one alive waits for the live one, then launches exactly the retry and the unlaunched key [UP1-1]', async () => {
      const { c, r } = await runs.D.get();
      expect(c.log().some((l) => l.startsWith('wait for ') && l.includes('dl-w1'))).toBe(true);
      expect(c.launches()).toEqual(['df-w1-a2', 'dn-w1']);
      expect(c.marker('d1-w1')).toBe('d1-w1\n');
      expect(c.marker('dl-w1')).toBe('dl-w1\n');
      expect(r.out.split('\n').sort()).toEqual(['BATCH 1 FAILED: df-w1-a2 runner exit 2', 'BATCH 1 FAILED: dn-w1 runner exit 2']);
    });

    it('a key whose stub fails in its folder, -a2 and -a3 exits 1, BATCH 1 RETRIES SPENT: <k>, and the step again exits the same way and launches nothing [SP1-1]', async () => {
      const { c, calls } = await runs.T.get();
      expect(calls.map((r) => r.code)).toEqual([3, 3, 1, 1]);
      expect(calls.map(last)).toEqual(['BATCH 1 FAILED: ta-w1 runner exit 2', 'BATCH 1 FAILED: ta-w1-a2 runner exit 2', 'BATCH 1 RETRIES SPENT: ta-w1-a3', 'BATCH 1 RETRIES SPENT: ta-w1-a3']);
      expect(c.launches()).toEqual(['ta-w1', 'ta-w1-a2', 'ta-w1-a3']);
    });
  });

  describe('the Failure model walk', () => {
    it('a batch killed with two runners alive and restarted waits for both, launches neither again and writes both markers [IO1]', async () => {
      const { c, third, survived, runners, beating, midway } = await runs.K.get();
      expect(survived.runners).toEqual([true, true]);
      expect(beating).toEqual([true, true]);
      // With ka released and finished, the restart still waits for kb: it is running, names kb alone, and has written no marker and no END.
      expect(midway).toEqual({ both: true, kbOnly: true, kaDone: true, running: true, markers: [], end: false });
      expect(c.launches()).toEqual(['ka-w1', 'kb-w1']);
      expect(c.runnerPids()).toEqual(runners);
      expect(c.marker('ka-w1')).toBe('ka-w1\n');
      expect(c.marker('kb-w1')).toBe('kb-w1\n');
      expect(third.code).toBe(1);
    });

    it('a start while a real second s4-batch.sh names the root exits 1 and launches none, which tests the scan against Git Bash\'s command lines [JO4]', async () => {
      const { c, first, second, batchLines } = await runs.K.get();
      expect(second.code).toBe(1);
      expect(second.out).toMatch(new RegExp(`^BATCH 1: s4-batch.sh \\d+ already runs on ${c.root}$`));
      expect(batchLines.length).toBeGreaterThan(0);
      expect(first.out).not.toContain('already runs');
      expect(c.launches()).toHaveLength(2);
    });

    it('a launcher started by a batch outlives that batch\'s tree kill [HO1]', async () => {
      const { survived } = await runs.K.get();
      expect(survived.launchers).toEqual([true, true]);
    });

    it('a launcher killed after Start-Process and before its pids.txt line, then the batch killed and restarted: it waits for the runner, launches none again and writes the marker from the Records: line [IO1, UP3-1]', async () => {
      const { c, pidsLines, r, launcher } = await runs.Pd.get();
      expect(pidsLines).toBe(0);
      expect(c.launches()).toEqual(['pb-w1']);
      expect(c.log().some((l) => l.startsWith('wait for ') && l.includes('pb-w1'))).toBe(true);
      expect(lines(`${c.dir('pb-w1')}/run.log`).some((l) => l.startsWith('Records: '))).toBe(true);
      expect(c.marker('pb-w1')).toBe('pb-w1\n');
      expect(r).toMatchObject({ code: 1, last: 'BATCH 1 REGRADE FAILED: pb-w1 regrade stub regrade failed on purpose' });
      expect(isAlive(launcher)).toBe(false);
    });

    it('every planned record written, no Records: line and exit 0: done by its records, with no -a2 folder [UP3-1]', async () => {
      const { c, r } = await runs.Pb.get();
      expect(lines(`${c.dir('pa-w1')}/run.log`).some((l) => l.startsWith('Records: '))).toBe(false);
      expect(c.marker('pa-w1')).toBe('pa-w1\n');
      expect(fs.existsSync(c.dir('pa-w1-a2'))).toBe(false);
      expect(c.launches()).toEqual(['pa-w1']);
      expect(r).toMatchObject({ code: 1, last: 'BATCH 1 REGRADE FAILED: pa-w1 regrade stub regrade failed on purpose' });
    });

    it('one record short and exit 0 with no Records: line: failed, and the step again retries it in <k>-w1-a2/ [UP3-1]', async () => {
      const { c, first, second } = await runs.Pr.get();
      expect(first).toMatchObject({ code: 3, last: 'BATCH 1 FAILED: pc-w1 runner exit 0' });
      expect(c.launches()).toEqual(['pc-w1', 'pc-w1-a2']);
      expect(c.flags('pc-w1-a2')).toMatchObject({ Retry: '2' });
      expect(c.marker('pc-w1')).toBe('pc-w1-a2\n');
      expect(second).toMatchObject({ code: 1, last: 'BATCH 1 REGRADE FAILED: pc-w1-a2 regrade stub regrade failed on purpose' });
    });

    it('a Start-Process that gives no pid exits 1 with BATCH 1 LAUNCH FAILED and its error text, never the launch.txt of an earlier launch [IO2]', async () => {
      const { c, r } = await runs.Ql.get();
      expect(r.code).toBe(1);
      expect(r.last).toBe('BATCH 1 LAUNCH FAILED: xa-w1 Start-Process gave no pid: no error text');
      expect(r.out).not.toContain('earlier launch');
      expect(c.launches()).toEqual([]);
      expect(fs.existsSync(`${c.dir('xa-w1')}/launch.txt`)).toBe(false);
      expect(fs.existsSync(`${c.dir('xa-w1')}/launcher-args.json`)).toBe(false);
    });

    it('a z0-unit-record arms refusal stops the batch with its line, and no launcher gets an empty -Arms', async () => {
      const { c, r } = await runs.Zr.get();
      expect(r).toMatchObject({ code: 1, last: 'BATCH 1: arms refused on purpose' });
      expect(c.launches()).toEqual([]);
    });

    it('a regrade stub that exits 1 gives BATCH 1 REGRADE FAILED: <k> regrade <line>, exit 1, and the step again reruns it [WP2-2]', async () => {
      const { c, third, fourth } = await runs.K.get();
      expect(third).toMatchObject({ code: 1, last: 'BATCH 1 REGRADE FAILED: ka-w1 regrade stub regrade failed on purpose' });
      expect(fourth.code).toBe(7);
      expect(callsOf(c, 'regrade')).toBe(3);
    });

    it('a launcher that exits 1 with a PINS: line before it starts a runner gives BATCH 1 LAUNCH FAILED, exit 1, no -a2, and the step again launches into the same folder [IO2]', async () => {
      const { c, first, second } = await runs.L.get();
      expect(first).toMatchObject({ code: 1, out: 'BATCH 1 LAUNCH FAILED: la-w1 PINS: the stub pinned file changed' });
      expect(lines(`${c.dir('la-w1')}/launcher-calls.txt`)).toHaveLength(2);
      expect(fs.existsSync(c.dir('la-w1-a2'))).toBe(false);
      expect(c.marker('la-w1')).toBe('la-w1\n');
      expect(second).toMatchObject({ code: 1, last: 'BATCH 1 REGRADE FAILED: la-w1 regrade stub regrade failed on purpose' });
    });

    it('a launcher killed while its runner finishes: done, no exit.txt and no failure line', async () => {
      const { c, first, exitFiles } = await runs.L.get();
      expect(exitFiles[1]).toBe(false);
      expect(first.out).not.toContain('lb-w1');
      expect(c.marker('lb-w1')).toBe('lb-w1\n');
    });

    it('a launcher that writes exit.txt only after the batch ended: done at the next poll, never a failure', async () => {
      const { c, first, second, exitFiles, lcExit } = await runs.L.get();
      expect(exitFiles[2]).toBe(false);
      expect(first.out).not.toContain('lc-w1');
      expect(lcExit.map((l) => l.trim())).toEqual(['0']);
      expect(second.out).not.toContain('lc-w1');
      expect(c.log().some((l) => l.startsWith('wait for ') && l.includes('lc-w1'))).toBe(true);
      expect(c.marker('lc-w1')).toBe('lc-w1\n');
    });

    it('a stub that prints its Records: line and never exits, mid-phase with no restart, frees its width slot and is stopped once run.log is Z0_GRACE_S old [MO2]', async () => {
      const { c, r, hangPid } = await runs.G.get();
      const launchB = at(c, 'launch gb-w1');
      const stopped = at(c, 'ga-w1 finished but did not exit, stopping pid ');
      expect(launchB).toBeGreaterThan(-1);
      expect(stopped).toBeGreaterThan(launchB);
      expect(c.log()[stopped]).toBe(`ga-w1 finished but did not exit, stopping pid ${hangPid}`);
      expect(isAlive(hangPid)).toBe(false);
      expect(r.last).toBe('BATCH 1 REGRADE FAILED: ga-w1 regrade stub regrade failed on purpose');
    });

    it('one still listed when G5 starts is stopped before the first call [MO2]', async () => {
      const { c } = await runs.G.get();
      expect(at(c, 'ga-w1 finished but did not exit')).toBeLessThan(at(c, 'call regrade ga-w1'));
    });

    it('a stub that prints Records: and never exits, with the batch killed and restarted: the restart\'s wait stops it, it stays done and the next phase starts [JO5, LO4]', async () => {
      const { c, r, stillAlive, hangPid } = await runs.G2.get();
      expect(stillAlive).toBe(true);
      expect(c.log().filter((l) => l.startsWith('gc-w1 finished but did not exit'))).toEqual([`gc-w1 finished but did not exit, stopping pid ${hangPid}`]);
      expect(isAlive(hangPid)).toBe(false);
      expect(c.marker('gc')).toBe('gc-w1\n');
      expect(fs.existsSync(c.dir('gc-w1-a2'))).toBe(false);
      expect(r.last).toBe('BATCH 1 REGRADE FAILED: gc-w1 regrade stub regrade failed on purpose');
    });

    it('a regrade stub that takes 20 s: the reader draw starts after it ends and never meets regrade.lock [WP2-2]', async () => {
      const { c, r } = await runs.W1.get();
      expect(stub(c, 'regrade').end - stub(c, 'regrade').start).toBeGreaterThanOrEqual(19_000);
      expect(stub(c, 'reader-draw').start).toBeGreaterThanOrEqual(stub(c, 'regrade').end);
      expect(['regrade', 'reader-draw', 'stored-draw'].map((call) => stub(c, call).lockSeen)).toEqual([false, false, false]);
      expect(r.code).toBe(7);
    });

    it('a stub killed while it holds the lock: the restart removes it, logs stale regrade lock, and reruns the call [WP2-2]', async () => {
      const { c, first, second, pid } = await runs.W2.get();
      expect(first.code).toBe(1);
      expect(first.last).toMatch(/^BATCH 1 REGRADE FAILED: wa-w1 regrade /);
      expect(c.log().filter((l) => l.startsWith('wa-w1 stale regrade lock '))).toEqual([`wa-w1 stale regrade lock ${pid} removed`]);
      expect(callsOf(c, 'regrade')).toBe(2);
      expect(second.code).toBe(7);
    });

    it('a regrade launcher killed while the stub finishes: the batch waits and reads the stub\'s log, with no second regrade [WP2-2]', async () => {
      const { c, r } = await runs.W3.get();
      expect(r.code).toBe(7);
      expect(callsOf(c, 'regrade')).toBe(1);
      expect(c.log().some((l) => l.startsWith('wait for wa-w1'))).toBe(true);
    });

    it('a draw killed after its key and before its line is skipped on the restart, so no second draw runs and the labels stop follows [WP2-1]', async () => {
      const { c, first, second, keyBefore } = await runs.W4.get();
      expect(first.last).toMatch(/^BATCH 1 REGRADE FAILED: wa-w1 reader-draw /);
      expect(keyBefore).toBe(true);
      expect(callsOf(c, 'reader-draw')).toBe(1);
      expect(second.code).toBe(7);
      expect(second.last).toBe(`BATCH 1 LABELS: 2 files to fill: ${c.dir('wa-w1')}/run/g5/reader-r1/labels.tsv ${c.dir('wa-w1')}/run/g5/stored/labels.tsv`);
    });
  });

  describe('the Record model', () => {
    it('a regrade stub whose summary shows 2 error rows runs once more, and a second such summary exits 1, REGRADE FAILED [KO6]', async () => {
      const a = await runs.W5a.get();
      expect(callsOf(a.c, 'regrade')).toBe(2);
      expect(a.r.code).toBe(7);
      const b = await runs.W5b.get();
      expect(callsOf(b.c, 'regrade')).toBe(2);
      expect(b.r).toMatchObject({ code: 1, out: 'BATCH 1 REGRADE FAILED: wa-w1 regrade 2 error rows' });
    });

    it('a malformed draw key, scored by the real z0-regrade.mjs, stops with its readSealed line, exit 1, the file unchanged [UP2-2]', async () => {
      const { third, keyText, keyAfter } = await runs.W4.get();
      expect(third.code).toBe(1);
      expect(third.last).toMatch(/^BATCH 1 REGRADE FAILED: wa-w1 reader-score .*sealed file does not parse; the harness never rebuilds it$/);
      expect(keyAfter).toBe(keyText);
    });

    it('a marker, a draw key and grading.json killed midway (a planted .tmp- file and no target) are written whole by the next call [UP2-1, TP2-2]', async () => {
      const { c, afterCall2, folders } = await runs.A.get();
      expect(afterCall2.tmpLeft).toEqual([]);
      expect(afterCall2.q145w1).toBe('q145-w1\n');
      expect(fs.existsSync(`${c.dir('q14-w1-a2')}/g5-reader-draw.stub.json`)).toBe(true);
      for (const n of folders) expect(json(`${c.dir(n)}/run/grading.json`)).toMatchObject({ g5: { readerRound: 1 } });
    });

    it('a torn temp beside a missing score file is no record: both score calls run and write the files whole [UP2-1, TP2-2]', async () => {
      const { c, r, sealed } = await runs.Pt.get();
      expect(r).toMatchObject({ code: 0, out: 'BATCH 1 DONE: 2 runs, 0 reruns, 2 regrades' });
      expect(at(c, 'call reader-score q145-w1 ')).toBeGreaterThan(-1);
      expect(at(c, 'call stored-score q145-w1 ')).toBeGreaterThan(-1);
      for (const f of ['reader-r1.score.json', 'stored.score.json']) expect(json(`${sealed}/${f}`)).toHaveProperty('labels');
    });

    it('a resume over completed G5 calls reads their sealed files: a malformed stored.key.json, a malformed stored.score.json and a missing reader score each stop it, with no END and exit 1 [UP2-2]', async () => {
      const { key, score, missing } = await runs.Sl.get();
      const sealed = (call: string, file: string, why: string) => new RegExp(`^BATCH 1 SEALED FAILED: q145-w1 ${call} .*${file}: ${why}$`);
      const broken = 'sealed file does not parse; the harness never rebuilds it';
      expect(key.r.last).toMatch(sealed('stored-draw', 'stored\\.key\\.json', broken));
      expect(score.r.last).toMatch(sealed('stored-score', 'stored\\.score\\.json', broken));
      expect(missing.r.last).toMatch(sealed('reader-score', 'reader-r1\\.score\\.json', 'sealed file is missing; call reader-score seals it'));
      for (const { c, r } of [key, score, missing]) {
        expect(r.code).toBe(1);
        expect(r.out).not.toContain('DONE');
        expect(fs.existsSync(`${c.root}/batch1/END`)).toBe(false);
      }
    });

    it('an END that cannot be written exits 1 with BATCH 1 END FAILED: write END exit 1, prints no DONE and leaves no END file or temp [GO4]', async () => {
      const { end, endRun } = await runs.E.get();
      expect(endRun).toMatchObject({ code: 1, last: 'BATCH 1 END FAILED: write END exit 1' });
      expect(endRun.out).not.toContain('DONE');
      expect(fs.statSync(`${end.root}/batch1/END`).isDirectory()).toBe(true);
      expect(fs.readdirSync(`${end.root}/batch1/END`)).toEqual([]);
      expect(fs.readdirSync(`${end.root}/batch1`).filter((n) => n.startsWith('END.tmp-'))).toEqual([]);
    });

    it('a marker that cannot be written exits 1 with BATCH 1 MARKER FAILED, logs no marker line and launches none [UP2-1]', async () => {
      const { mark, markRun } = await runs.E.get();
      expect(markRun).toMatchObject({ code: 1, last: 'BATCH 1 MARKER FAILED: write q145-w1 exit 1' });
      expect(mark.log().some((l) => l.startsWith('marker q145-w1 '))).toBe(false);
      expect(mark.launches()).toEqual([]);
    });

    it('END is written last and whole: a planted END.tmp- is replaced, and the rerun writes the same end-phase files [GO4]', async () => {
      const { rewritten, end, c } = await runs.Pq.get();
      expect(rewritten.same).toBe(true);
      expect(rewritten.end).toBe(end);
      expect(rewritten.tmp).toBe(false);
      expect(rewritten.scaleSame).toBe(true);
      expect(end).toBe('BATCH 1 DONE: 2 runs, 1 reruns, 3 regrades\n');
      expect(c.log().filter((l) => l.startsWith('marker ')).length).toBeGreaterThan(0);
    });
  });

  describe('G5 and the end phase', () => {
    it('the labels stop exits 7 until every file is filled, and the rerun writes each grading.json after the folder\'s scores [WP2-1]', async () => {
      const { c, calls, folders, grading0 } = await runs.A.get();
      expect(calls[2].code).toBe(7);
      expect(calls[2].out).toMatch(new RegExp(`^BATCH 1 LABELS: 8 files to fill: ${c.dir('q145-w1')}/run/g5/reader-r1/labels.tsv `));
      expect(calls[2].out.split(' ').filter((w) => w.endsWith('labels.tsv'))).toHaveLength(8);
      for (const n of folders) {
        const i = at(c, `call reader-score ${n} `);
        expect(i).toBeGreaterThan(-1);
        expect(at(c, `call stored-score ${n} `)).toBeGreaterThan(i);
        expect(at(c, `call grading ${n} `)).toBeGreaterThan(at(c, `call stored-score ${n} `));
      }
      expect(grading0).toEqual([false, false, false, false]);
      expect(calls[3]).toMatchObject({ code: 0, out: 'BATCH 1 DONE: 2 runs, 2 reruns, 4 regrades' });
    });

    it('the end phase runs g1-pins before z0-merge, and the merge reads the first run\'s file [CP1-3]', async () => {
      const { c } = await runs.A.get();
      const first = c.dir('q145-w1');
      const pins = c.log().map((l, i) => (l.startsWith('cmd g1-pins ') ? i : -1)).filter((i) => i > -1);
      expect(pins).toHaveLength(4);
      const merge = cmds(c, 'z0-merge');
      expect(merge).toHaveLength(1);
      expect(at(c, 'cmd z0-merge ')).toBeGreaterThan(Math.max(...pins));
      expect(merge[0]).toContain(`--first ${first}/run --leaks ${first}/leaks.json --first-off-pin ${first}/off-pin.json --rerun-of ${c.dir('q145-e1')}/run --rerun-of ${c.dir('q145-e3-a2')}/run --out ${c.root}/merged/batch1/q145-w1 exit 0`);
      const order = ['cmd z0-merge ', 'cmd z0-read-set ', 'cmd z0-hookhold --design r4 --runs', 'cmd z0-grading-combine ', 'cmd z0-ledger ', 'cmd z0-budget '].map((p, i) => (i === 2 ? c.log().findIndex((l) => l.startsWith('cmd z0-hookhold ') && l.includes(' --sensitivity ')) : at(c, p)));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(order.every((i) => i > -1)).toBe(true);
    });

    it('the batch calls z0-budget only for scale, once [SP1-1]', async () => {
      const { c } = await runs.A.get();
      const budget = c.log().filter((l) => l.startsWith('cmd z0-budget '));
      expect(budget).toHaveLength(1);
      expect(budget[0]).toMatch(/^cmd z0-budget scale --batch1-ledger [\d.]+ --spend-basis /);
    });

    it('z0-read-set lists the -a2 folders only, and the merged folder of the leaked key [YP2-1]', async () => {
      const { c } = await runs.A.get();
      const set = read(`${c.root}/batch1/read-set.txt`);
      expect(set).toContain(`${c.dir('q14-w1-a2')}/run/runs.jsonl`);
      expect(set).not.toContain(`${c.dir('q14-w1')}/`);
      expect(set).toContain(`${c.dir('q145-e3-a2')}/run/runs.jsonl`);
      expect(set).not.toContain(`${c.dir('q145-e3')}/`);
      expect(set).toContain(`${c.root}/merged/batch1/q145-w1/runs.jsonl`);
    });

    it('z0-ledger counts every attempt folder, the failed attempts\' warm-ups included, and scale.json is sealed once [KO2]', async () => {
      const { c, scale, f } = await runs.A.get();
      const n = { q145: c.size(f.q145), q14: c.size(f.q14), e1: c.size(f.e1), e3: c.size(f.e3) };
      const recorded = n.q145 + 1 + n.q14 + n.e1 + 1 + n.e3;
      const want = recorded * COST + 6 * 2 * WARM;
      const line = cmds(c, 'z0-ledger')[0];
      expect(line).toContain('--run');
      expect(Number(c.log().find((l) => l.startsWith('cmd z0-ledger '))!.match(/exit 0: LEDGER ([\d.]+)/)![1])).toBeCloseTo(want, 6);
      expect(json(`${c.root}/scale.json`)).toBeTruthy();
      expect(scale.length).toBeGreaterThan(0);
    });

    it('a run after END prints its line, exits 0, launches none, and leaves scale.json as it was [KO2]', async () => {
      const { c, calls, scale, scaleTime, launchesBefore } = await runs.A.get();
      expect(calls[4]).toMatchObject({ code: 0, out: 'BATCH 1 DONE: 2 runs, 2 reruns, 4 regrades' });
      expect(c.launches()).toHaveLength(launchesBefore);
      expect(read(`${c.root}/scale.json`)).toBe(scale);
      expect(fs.statSync(`${c.root}/scale.json`).mtimeMs).toBe(scaleTime);
      expect(read(`${c.root}/batch1/END`)).toBe('BATCH 1 DONE: 2 runs, 2 reruns, 4 regrades\n');
    });

    it('the end phase writes its outputs and the done line [CP1-3]', async () => {
      const { first, third, outputs, c } = await runs.Pq.get();
      expect(first).toMatchObject({ code: 0, out: 'BATCH 1 DONE: 2 runs, 1 reruns, 3 regrades' });
      for (const f of outputs) expect(fs.existsSync(f)).toBe(true);
      expect(third).toMatchObject({ code: 0, out: 'BATCH 1 DONE: 2 runs, 1 reruns, 3 regrades' });
      expect(json(`${c.root}/batch1/drop-list.json`)).toHaveProperty('hookVoids');
    });

    it('an end-phase command that fails exits 1 with BATCH 1 END FAILED, naming the command and its exit [GO4, ZP2-3]', async () => {
      const { r, c } = await runs.Pf.get();
      expect(r).toMatchObject({ code: 1, out: 'BATCH 1 END FAILED: g1-pins exit 1' });
      expect(fs.existsSync(`${c.root}/batch1/END`)).toBe(false);
    });
  });

  describe('the scan', () => {
    it('a live stub in <k>-w1-a2 leaves <k>-w1 not alive, and a stub spelled c:/Z0-RUNS-style reads as the same folder [JO3]', async () => {
      const { plain, retry, mixedCase } = await runs.S.get();
      expect([plain, retry, mixedCase]).toEqual([1, 0, 0]);
    });

    it('a stub on a dry root is not one on C:/z0-runs/r4', async () => {
      const { under, dry, a2 } = await runs.S.get();
      expect(under).toContain(`${a2} ab-run `);
      expect(dry).not.toContain(`${a2} `);
    });

    it('a live bash -c wrapper and a live powershell -Command whose text names the folder and s4-run.ps1, with no runner, read not alive', async () => {
      const { wrapper } = await runs.S.get();
      expect(wrapper).toBe(1);
    });

    it('the direct run with no function prints the usage and exits 1', async () => {
      const { usage } = await runs.S.get();
      expect(usage.status).toBe(1);
      expect(usage.stdout).toContain('usage: Z0_CHECKOUT=<checkout> bash s4-units.sh <function> <args>');
    });
  });

  describe('the stubs end on their own when a test never releases them', () => {
    const HOLD = { Z0_STUB_HOLD_S: '1' };
    const gaveUp = (what: string) => `stub ${what}: still held after Z0_STUB_HOLD_S=1 s, exiting 9`;
    const node = (c: Case, script: string, args: string[]) => spawnSync(process.execPath, [`${c.scored}/${script}`, ...args], { env: c.env(HOLD), encoding: 'utf8', cwd: c.base, timeout: 25_000 });

    it('a held runner, a beating runner and a hung runner each exit 9 with a line naming the bound', () => {
      const c = track(new Case({ name: 'Hr', keys1: ['ha'] }));
      const never = `${c.base}/never`;
      const fixture = KEY_FX(c, 'ha', [1]);
      c.knob('ha-w1', { fixture, release: never });
      c.knob('ha-w2', { fixture, hang: true, beatUntil: never });
      c.knob('ha-e1', { fixture, hang: true });
      const [held, beat, hung] = ['ha-w1', 'ha-w2', 'ha-e1'].map((n) => node(c, 'ab-run.mjs', ['--out', `${c.dir(n)}/run`]));
      expect(held).toMatchObject({ status: 9, stderr: expect.stringContaining(gaveUp(`runner release waiting for ${never}`)) });
      expect(held.stdout).not.toContain('Records: ');
      expect(Number(read(`${c.dir('ha-w1')}/held.beat`))).toBeGreaterThan(0);
      expect(beat).toMatchObject({ status: 9, stderr: expect.stringContaining(gaveUp(`runner beat waiting for ${never}`)) });
      expect(beat.stdout).toContain('beat\n');
      expect(hung).toMatchObject({ status: 9, stderr: expect.stringContaining(gaveUp('runner hang')) });
    });

    it('a held launcher, a held regrade stub and a hung regrade stub each exit 9 with a line naming the bound', () => {
      const c = track(new Case({ name: 'Hl', keys1: ['hb'] }));
      const never = `${c.base}/never`;
      c.knob('hb-w1', { fixture: KEY_FX(c, 'hb', [1]), exitRelease: never, regrade: { release: never } });
      c.knob('hb-w2', { regrade: { hangOnce: true } });
      const launcher = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', `${c.scored}/s4-run.ps1`, '-Checkout', CHECKOUT, '-Root', c.root, '-Batch', '1', '-Key', 'hb', '-Toolchain', 'node', '-Folder', c.dir('hb-w1')], { env: c.env(HOLD), encoding: 'utf8', input: '', cwd: c.base, timeout: 25_000 });
      expect(launcher.status).toBe(9);
      expect(launcher.stdout.trim().split(/\r?\n/).at(-1)).toBe(gaveUp(`launcher exit.txt waiting for ${never}`));
      expect(fs.existsSync(`${c.dir('hb-w1')}/run/exit.txt`)).toBe(false);
      const regrade = (n: string) => node(c, 'z0-regrade.mjs', ['regrade', '--out', `${c.dir(n)}/run`, '--tasks', `${c.base}/tasks.json`]);
      expect(regrade('hb-w1')).toMatchObject({ status: 9, stderr: expect.stringContaining(gaveUp(`regrade regrade release waiting for ${never}`)) });
      expect(regrade('hb-w2')).toMatchObject({ status: 9, stderr: expect.stringContaining(gaveUp('regrade regrade hang')) });
    });
  });
});
