// Set-up for the s4-drive.sh tests: a fixture checkout (a git repository with the freeze tag), a dry root with real pins and a spend basis, a "scored" folder holding the real driver
// beside the stubs, and a spawned driver. Only the budget, pins, unit-record and drive CLIs run real; every other CLI, the launcher, the batch and the read are stubs.
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DESIGNS } from '../../../scripts/token-eval/arms.mjs';
import { gitBash } from '../../../scripts/token-eval/homes.mjs';
import { PILOT_CHECKS } from '../../../scripts/token-eval/z0-budget.mjs';
import { runCli as pinsCli } from '../../../scripts/token-eval/z0-pins-check.mjs';
import { BASIS, BATCH1, BATCH2, BATCH2_SEQ, MEAN, SEQ } from '../../_helpers/z0-r4-spend.js';
import { PRICES_BY_MODEL, generate, planOf } from '../z0-gen.js';
import { testGit } from '../test-git.js';
import { replay } from '../z0-batch/ab-run.mjs';
import { CHECKOUT as REPO, fwd, isAlive, json, lines, makeFixture, put, read, sleep, until } from '../z0-batch/harness.js';
import { killNaming, killOwnTree, procsNaming } from '../kill-own.js';

export { fwd, isAlive, json, lines, put, read, sleep, until };
export const POETRY = 'C:/z0-runs/r4/poetry-2.5.1';
export const TESTS = 'C:/z0-drive-tests';
const LAUNCH = path.join(REPO, 'scripts', 'token-eval', 'r4-launch');
const HERE = fwd(__dirname);
const STUBBED = ['ab-run', 'g1-pins', 'z0-pilot', 'z0-ledger', 'z0-size', 'z0-seed-rule', 'z0-read-set', 'z0-hookhold', 'z0-grading-combine'];
/** The steps that start a launcher, and so need `--fake` on a dry root. */
export const LAUNCH_STEPS = ['smoke', '1', '3', '5', '6'];
export const PILOT_KEYS = ['k1', 'k2'];
export const TAG_1 = 'z0-r4-freeze-1';
export const TAG_2 = 'z0-r4-freeze-2';

/** One entry of drive-log.jsonl, every field present. */
export interface Entry {
  step: string; attempt: number | null; exit: number; stopId: string | null; line: string | null; tag: string | null; commit: string | null; pinsSha256: string | null;
  claudeVersion: string | null; question: string | null; figure: number | null; stop: boolean | null; kind: string | null; failedStep: string | null; spent: string | null;
}
export interface Run { code: number | null; out: string; lines: string[]; last: string }
/** `outFile` is where the call writes its output, for a test that waits on a line before the call ends. */
export interface Started { child: ReturnType<typeof spawn>; done: Promise<Run>; outFile: string }
export interface StubCall { cli: string; argv: string[] }
/** One item of a stub CLI's list; the list is used one item per call and its last item stays. */
export interface CliKnob { exit?: number; stdout?: string; stderr?: string; write?: Record<string, string>; make?: string[]; hangMs?: number; holdUntil?: string; holdMaxMs?: number }
/** A stub runner's knob, read by the stub `ab-run.mjs` from the name of its folder. */
export interface Knob { fixture?: string; plan?: string; records?: number; printRecords?: boolean; exit?: number; startMs?: number; endMs?: number; hang?: boolean; launchExit?: number; release?: string }
/** One line of budget-log.jsonl: the admit lines carry the unit names and the verdict. */
export interface BudgetLine { kind: string; step?: string; units?: string[]; admitted?: boolean; reason?: string | null; approved?: number; attempt?: number; ledgerBefore?: number; maxSeed?: number; cap?: number; capSpend?: number; projection?: number }
export interface PilotJson { schema: string; attempt: number; tag: string; r: Record<string, number>; rArm: string; rMax: number; flag19: boolean; ledgerTotal: number; pilotSpend: number; checks: Record<string, string> }
export interface World { base: string; checkout: string; commit: string; fx: string; plan: string }

const git = (dir: string, ...args: string[]): string => testGit(dir, ...args).trim();
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A fixture checkout under `base`: the repository's scripts, bin and dist in a clean git repository; `tagged` gives it the freeze-1 tag. Never tags or commits in the worktree. */
export function makeCheckout(base: string, name: string, tagged = true): string {
  const dir = `${base}/${name}`;
  fs.mkdirSync(dir, { recursive: true });
  for (const folder of ['scripts', 'bin', 'dist']) fs.cpSync(path.join(REPO, folder), `${dir}/${folder}`, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), `${dir}/package.json`);
  put(`${dir}/.gitignore`, 'dist/\n');
  git(dir, 'init', '-q');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(dir, 'config', k, v);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture checkout');
  if (tagged) git(dir, 'tag', TAG_1);
  // stage-checks diffs src and extensions against round 4's base commit; a tag of that name on the root commit lets the diff resolve in a repository that never held it.
  git(dir, 'tag', '04835462b');
  return dir;
}

export function makeWorld(prefix: string): World {
  fs.mkdirSync(TESTS, { recursive: true });
  const base = fwd(fs.mkdtempSync(`${TESTS}/${prefix}-`));
  const checkout = makeCheckout(base, 'checkout');
  const fx = `${base}/fx`;
  makeFixture(fx, { key: 'k1', seeds: [1] });
  // A small dry plan, so the pilot's four plans stay under its $40 cap at the mean cost per record.
  const plan = `${base}/small-plan.json`;
  put(plan, JSON.stringify(planOf(generate({ design: DESIGNS.r4, repos: 1 }).records.filter((r) => r.seed === 1 && r.position <= 2).slice(0, 6))));
  return { base, checkout, commit: git(checkout, 'rev-parse', 'HEAD'), fx, plan };
}

/** Removes the world's own folder, and the tests folder when nothing else is in it. */
export function dropWorld(w: World | undefined) {
  if (w?.base.startsWith(`${TESTS}/`)) fs.rmSync(w.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  if (fs.existsSync(TESTS) && fs.readdirSync(TESTS).length === 0) fs.rmdirSync(TESTS);
}

// SAFETY: the driver, z0-budget and the stub CLIs write these files one whole JSON object a line, and the caller names the type its file holds.
const jsonLines = <T>(file: string): T[] => lines(file).map((l) => JSON.parse(l) as T);

export const pilotJson = (over: Partial<PilotJson> = {}): PilotJson => ({
  schema: 'z0-pilot/1', attempt: 1, tag: TAG_1, r: { S1: 1, S2: 1 }, rArm: 'S2', rMax: 1, flag19: false, ledgerTotal: 4, pilotSpend: 3.5, checks: Object.fromEntries(PILOT_CHECKS.map((id) => [id, 'pass'])), ...over,
});

export class DriveCase {
  readonly dir: string;
  readonly root: string;
  readonly scored: string;
  readonly knobs: string;
  readonly stubs: string;
  readonly checkout: string;
  private readonly children = new Set<ChildProcess>();
  private n = 0;

  constructor(readonly w: World, name: string, checkout = w.checkout) {
    this.dir = `${w.base}/${name}`;
    [this.root, this.scored, this.knobs, this.stubs] = ['root', 'scored', 'knobs', 'stubs/scripts/token-eval'].map((d) => `${this.dir}/${d}`);
    this.checkout = checkout;
    for (const d of [this.scored, this.knobs, this.stubs]) fs.mkdirSync(d, { recursive: true });
    for (const f of ['s4-drive.sh', 's4-units.sh', 's4-procs.ps1']) fs.copyFileSync(path.join(LAUNCH, f), `${this.scored}/${f}`);
    for (const f of ['s4-run.ps1', 's4-batch.sh', 's4-read.sh', 'stub-cli.mjs']) fs.copyFileSync(`${HERE}/${f}`, `${this.scored}/${f}`);
    fs.copyFileSync(path.join(REPO, 'tests', 'fixtures', 'z0-batch', 'ab-run.mjs'), `${this.scored}/ab-run.mjs`);
    for (const n of STUBBED) fs.copyFileSync(`${HERE}/stub-cli.mjs`, `${this.stubs}/${n}.mjs`);
    put(`${this.knobs}/fake.json`, '{}');
    put(`${this.knobs}/default.json`, JSON.stringify({ fixture: w.fx, plan: w.plan }));
    this.cliKnob('z0-ledger', [{ stdout: 'LEDGER 1.00' }]);
    this.cliKnob('z0-pilot', [{ write: { [`${this.root}/pilot.json`]: `${JSON.stringify(pilotJson())}\n` } }]);
    this.makeRoot();
  }

  private makeRoot() {
    const keys = ['effort', ...PILOT_KEYS];
    put(`${this.root}/DRYRUN`, '');
    put(`${this.root}/pilot-tasks/repos.json`, JSON.stringify(Object.fromEntries(keys.map((k, i) => [k, { toolchain: i % 2 === 0 ? 'node' : 'python' }]))));
    for (const k of keys) put(`${this.root}/pilot-tasks/${k}/tasks-run.json`, '{}\n');
    for (const k of PILOT_KEYS) put(`${this.root}/tasks/${k}/tasks-run.json`, '{}\n');
    put(`${this.root}/spend-basis.json`, JSON.stringify({ schema: 'z0-spend-basis/1', basisByArm: BASIS, bySequence: { ...SEQ, ...BATCH2_SEQ }, meanPerRecord: MEAN }));
    put(`${this.root}/prices.json`, JSON.stringify(PRICES_BY_MODEL));
    put(`${this.root}/r3-inputs.txt`, `--runs ${this.root}/r3/runs.jsonl --plan ${this.root}/r3/plan.json\n`);
    put(`${this.root}/pip-constraints.txt`, 'poetry==2.5.1\n');
    this.sealTasks();
    put(`${this.root}/pin-roles.txt`, [
      ...['s4-drive.sh', 's4-units.sh', 's4-procs.ps1', 's4-run.ps1', 's4-batch.sh', 's4-read.sh'].map((f) => `${f.replace(/\..*$/, '')}=${this.scored}/${f}`), `tree:tasks=${this.root}/tasks`,
    ].join('\n') + '\n');
    this.writePins();
  }

  /** The tasks folder's manifest, as the pins check reads it. */
  sealTasks() {
    const r = pinsCli(['--manifest', `${this.root}/tasks`], this.dir);
    if (r.code !== 0) throw new Error(`manifest failed: ${r.stderr}`);
  }

  /** Writes pins-r4.json and its two effort variants with the real pins check; `set` overrides the keys given. */
  writePins(set: Record<string, string> = {}) {
    const pairs = { effort: 'medium', claudeVersion: '9.9.9', modelOpus: 'claude-opus-5-5', modelSonnet: 'claude-sonnet-5-5', wholeRunSeeds: '5', batch1Keys: BATCH1.join(','), batch2Keys: BATCH2.join(','), ...set };
    const r = pinsCli(['--write', `${this.root}/pins-r4.json`, '--checkout', this.checkout, '--roles', `${this.root}/pin-roles.txt`, '--poetry', POETRY,
      ...Object.entries(pairs).flatMap(([k, v]) => ['--set', `${k}=${v}`])], this.dir);
    if (r.code !== 0) throw new Error(`pins write failed: ${r.stderr}`);
  }
  pinsSha() { return sha256(`${this.root}/pins-r4.json`); }

  /** A passing pilot file, so steps 2 and later find one. */
  pilot(over: Partial<PilotJson> = {}) { put(`${this.root}/pilot.json`, `${JSON.stringify(pilotJson(over))}\n`); }
  /** The sealed scale batch 2 and the raise read. */
  scale() { put(`${this.root}/scale.json`, `${JSON.stringify({ scale: 1, ledger: 1, projection: 1 })}\n`); }
  /** A whole-run plan for each pilot key, as `plans` leaves them. */
  wholePlans() { for (const k of PILOT_KEYS) put(`${this.root}/whole-plan/${k}/plan.json`, read(this.w.plan)); }

  /** The stub ab-run writes each pilot key's whole-run plan, as `plans` expects. */
  stubPlans() { this.cliKnob('ab-run', PILOT_KEYS.map((k) => ({ write: { [`${this.root}/whole-plan/${k}/plan.json`]: read(this.w.plan) } }))); }

  knob(name: string, body: Knob) { put(`${this.knobs}/${name}.json`, JSON.stringify(body)); }
  cliKnob(name: string, list: CliKnob[]) { put(`${this.knobs}/cli-${name}.json`, JSON.stringify(list)); }
  /** The knob of the stub s4-batch.sh or s4-read.sh, as a list of calls. */
  script(name: 's4-batch' | 's4-read', list: CliKnob[]) { this.cliKnob(name, list); }

  /** A folder with no DRYRUN file, for the input refusals. */
  realRoot() {
    const dir = `${this.dir}/real`;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A drive-log entry of this case's checkout and pins, every field set. */
  entry(over: Partial<Entry> & { step: string; exit: number }): Entry {
    return {
      attempt: 1, stopId: null, line: null, tag: TAG_1, commit: git(this.checkout, 'rev-parse', 'HEAD'), pinsSha256: this.pinsSha(), claudeVersion: '9.9.9', question: null, figure: null, stop: null, kind: null,
      failedStep: null, spent: null, ...over,
    };
  }
  /** Adds an entry to the drive log, as an earlier call would have left it. */
  plant(over: Partial<Entry> & { step: string; exit: number }) { fs.appendFileSync(`${this.root}/drive-log.jsonl`, `${JSON.stringify(this.entry(over))}\n`); }

  /** A finished unit folder: the fixture's records, plan and warm-ups, and the runner's Records: line. */
  async doneUnit(folder: string) {
    await replay(this.w.fx, `${folder}/run`, null);
    put(`${folder}/run.log`, `\nRecords: ${folder}/run/runs.jsonl\n`);
  }
  /** The batch folders `s4-drive.sh 6` reads: a done marker and an empty leak list per key. */
  g5Done() {
    for (const [n, keys] of [['1', BATCH1], ['2', BATCH2]] as const) {
      for (const k of keys) {
        put(`${this.root}/batch${n}/done/${k}`, `${k}-w1`);
        put(`${this.root}/batch${n}/${k}-w1/leaks.json`, JSON.stringify({ leaks: [] }));
      }
    }
  }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, Z0_STUB_KNOBS: this.knobs, Z0_DRIVE_STUBS: this.stubs, Z0_GRACE_S: '4', ...extra };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return env;
  }

  /** One s4-drive.sh call; output goes to a file so no pipe stays open behind a runner. `raw` adds neither --poll nor --fake. */
  start(step: string, extra: string[] = [], o: { env?: Record<string, string | undefined>; raw?: boolean; root?: string; checkout?: string } = {}): Started {
    const out = `${this.dir}/out-${++this.n}.txt`;
    const fd = fs.openSync(out, 'w');
    const more = [...extra];
    if (!o.raw && !more.includes('--poll')) more.push('--poll', '1');
    if (!o.raw && LAUNCH_STEPS.includes(step) && !more.includes('--fake')) more.push('--fake', `${this.knobs}/fake.json`);
    const child = spawn(gitBash(process.env, []), [`${this.scored}/s4-drive.sh`, step, o.checkout ?? this.checkout, o.root ?? this.root, ...more], { env: this.env(o.env), stdio: ['ignore', fd, fd], windowsHide: true, cwd: this.dir });
    fs.closeSync(fd);
    this.children.add(child);
    const done = new Promise<Run>((resolve) => child.on('exit', (code) => {
      const text = fs.existsSync(out) ? read(out).replace(/\r/g, '').trim() : '';
      const all = text === '' ? [] : text.split('\n');
      resolve({ code, out: text, lines: all, last: all.at(-1) ?? '' });
    }));
    return { child, done, outFile: out };
  }
  run(step: string, extra: string[] = [], o: Parameters<DriveCase['start']>[2] = {}) { return this.start(step, extra, o).done; }

  /** A stub script or CLI started on its own, as a process left by a dead driver would be. */
  orphan(file: string, args: string[]) {
    const [cmd, argv] = file.endsWith('.sh') ? [gitBash(process.env, []), [file, ...args]] : [process.execPath, [file, ...args]];
    const child = spawn(cmd, argv, { env: this.env(), stdio: 'ignore', windowsHide: true, cwd: this.dir });
    this.children.add(child);
    return child;
  }

  /** Every entry of the drive log, in order. */
  allEntries() { return jsonLines<Entry>(`${this.root}/drive-log.jsonl`); }
  /** The outcome, fault and refusal entries: a start entry is not one, so `starts()` holds those. */
  entries() { return this.allEntries().filter((e) => e.stopId !== 'start'); }
  starts() { return this.allEntries().filter((e) => e.stopId === 'start'); }
  budget() { return jsonLines<BudgetLine>(`${this.root}/budget-log.jsonl`); }
  admits() { return this.budget().filter((e) => e.kind === 'admit'); }
  /** The stub CLI calls, in order, for one CLI or all. */
  stubCalls(name?: string) { return jsonLines<StubCall>(`${this.knobs}/calls.jsonl`).filter((c) => name === undefined || c.cli === name); }
  /** drive.log without its time stamps. */
  log() { return lines(`${this.root}/drive.log`).map((l) => l.replace(/^\d\d-\d\d \d\d:\d\d:\d\d /, '')); }
  /** The pid of the runner of each `<key> <pid> <folder>` line of `<b>/pids.txt`. */
  runnerPids(b: string) { return lines(`${this.root}/${b}/pids.txt`).map((l) => Number(l.split(' ')[1])); }
  driverPid() { return Number(/ pid (\d+)$/.exec(this.log().find((l) => l.startsWith('call '))!)![1]); }
  launcherPid(name: string) { return Number(this.log().find((l) => l.startsWith(`launch ${name} pid `))!.split(' ')[3]); }
  launches() { return this.log().filter((l) => l.startsWith('launch ')).map((l) => l.split(' ')[1]); }
  stubLog() { return lines(`${this.root}/stubs.log`); }
  launcherArgs(folder: string): Record<string, string> { return json(`${folder}/launcher-args.json`); }
  launcherCalls(folder: string) { return lines(`${folder}/launcher-calls.txt`); }
  /** The mark of this case: every process of it names its folder, and the slash keeps `print` apart from `print-live`. */
  private get mark() { return `${this.dir}/`; }
  /** Kills `pid`, a launcher or driver pid read from this case's own files, only while it is a live process naming this case's folder; anything else is an error, never a kill. */
  kill(pid: number) {
    if (!killNaming([this.mark], [pid]).includes(pid)) throw new Error(`pid ${pid} is not a live process of case ${this.dir}, so it was not killed`);
  }

  /** Stops what this case spawned, then every live process naming its folder, until none is left; a child whose kill throws is reported after the sweep and the folder removal, never in place of them. */
  async cleanup() {
    const failed: string[] = [];
    for (const child of this.children) {
      try {
        killOwnTree(child);
      } catch (err) {
        failed.push(String(err));
      }
    }
    let left = procsNaming([this.mark]).get(this.mark) ?? [];
    for (let i = 0; left.length > 0 && i < 20; i++) {
      killNaming([this.mark]);
      await sleep(500);
      left = procsNaming([this.mark]).get(this.mark) ?? [];
    }
    if (left.length > 0) failed.push(`live processes remain: ${left.join(' ')}`);
    else fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    if (failed.length > 0) throw new Error(`cleanup of case ${this.dir} failed: ${failed.join('; ')}`);
  }
}
