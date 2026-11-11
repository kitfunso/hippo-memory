// Set-up for the s4-batch.sh tests: a dry root, a "scored" folder holding the real scripts beside the stubs, fixture runs the stub runner replays, and a spawned batch.
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ARM_TABLE, DESIGNS } from '../../../scripts/token-eval/arms.mjs';
import { gitBash } from '../../../scripts/token-eval/homes.mjs';
import { BASIS, BATCH2_SEQ, MEAN, SEQ } from '../../_helpers/z0-r4-spend.js';
import { PRICES_BY_MODEL, generate, planOf, type Z0Record } from '../z0-gen.js';
import { replay } from './ab-run.mjs';

export const fwd = (p: string) => p.replace(/\\/g, '/');
export const CHECKOUT = fwd(path.resolve(__dirname, '..', '..', '..'));
const LAUNCH = path.join(CHECKOUT, 'scripts', 'token-eval', 'r4-launch');
const PINS = { modelOpus: 'claude-opus-5-5', modelSonnet: 'claude-sonnet-5-5', effort: 'medium' };
export const COST = 0.1;
export const WARM = 0.5;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
export const read = (file: string) => fs.readFileSync(file, 'utf8');
export const json = (file: string) => JSON.parse(read(file));
export const lines = (file: string) => (fs.existsSync(file) ? read(file).split(/\r?\n/).filter((l) => l !== '') : []);

/** Polls `test` until it holds; the message names what never happened. */
export async function until(what: string, test: () => boolean, ms = 180_000) {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

export const isAlive = (pid: number) => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' }).stdout.includes(`"${pid}"`);
export const kill = (pid: number, tree = false) => spawnSync('taskkill', [...(tree ? ['/T'] : []), '/F', '/PID', String(pid)], { encoding: 'utf8' });

export interface FxOpts { key: string; seeds: number[]; leaks?: number[]; tag?: string }
interface Rec extends Z0Record { sessionId: string; costUsd: number; hookCancels: Record<string, never>; envKeys: string[] }
/** A call's knobs for the stub z0-regrade.mjs. */
export interface CallKnob { durationS?: number; lock?: boolean; errorRows?: { times: number; rows: number }; hangOnce?: boolean; keyNoLine?: boolean; exit?: number; real?: boolean }
/** The stub runner's, launcher's and regrade stub's knobs for one unit folder, read by file name from the knobs folder. */
export interface Knobs {
  fixture?: string; startMs?: number; endMs?: number; gapMs?: number; records?: number; printRecords?: boolean; exit?: number; hang?: boolean; abandon?: boolean;
  pins?: 'once' | 'always'; box?: 'once' | 'always'; pidsDelayS?: number; exitDelayS?: number;
  regrade?: CallKnob; 'reader-draw'?: CallKnob; 'stored-draw'?: CallKnob; 'reader-score'?: CallKnob; 'stored-score'?: CallKnob; grading?: CallKnob;
}
/** One fixture run (static files, and one step per record for the stub runner to replay); returns its records. */
export function makeFixture(dir: string, o: FxOpts): Rec[] {
  const all = generate({ design: DESIGNS.r4, repos: 1 }).records;
  const tag = o.tag ?? 'f';
  // A raise seed (4 and up) clones the rule arms' seed 3 records.
  const records = o.seeds.flatMap((seed) => all.filter((r) => r.seed === Math.min(seed, 3)).map((r): Rec => ({
    ...r, sequence: `rn-${o.key}`, seed, sessionId: `s-${tag}-${r.arm}-${seed}-${r.position}`, surfaceRestored: true, costUsd: COST, hookCancels: {}, envKeys: ['PATH', 'PIP_CONSTRAINT'], leak: (o.leaks ?? []).includes(seed) && r.position === 4,
  })));
  const pinOf = (arm: string) => (ARM_TABLE[arm].pinKey === 'modelOpus' ? PINS.modelOpus : PINS.modelSonnet);
  const steps = records.map((r) => {
    const where = path.posix.join('raw', r.sequence, r.arm, `seed${r.seed}`);
    const name = `${r.taskId}.session1.requests.jsonl`;
    return {
      record: r, attemptsFile: `${where}/attempts.jsonl`, logFile: `${where}/${name}`,
      attempt: { taskId: r.taskId, kind: 'session', attempt: 1, sessionId: r.sessionId, logFile: `C:\\elsewhere\\raw\\${name}`, sizesBefore: null },
      log: `${JSON.stringify({ at: 't', method: 'POST', url: '/v1/messages', body: JSON.stringify({ model: pinOf(r.arm), output_config: { effort: 'medium' }, messages: [] }) })}\n`,
    };
  });
  put(path.join(dir, 'static', 'plan.json'), JSON.stringify(planOf(records)));
  for (const model of [PINS.modelOpus, PINS.modelSonnet]) put(path.join(dir, 'static', 'warmups', `${model}.json`), JSON.stringify({ model, status: 0, total_cost_usd: WARM, result: null }));
  put(path.join(dir, 'steps.json'), JSON.stringify(steps));
  return records;
}

export interface Run { code: number | null; out: string; last: string }
export interface Started { child: ReturnType<typeof spawn>; done: Promise<Run> }
export interface CaseOpts { name: string; b?: 'batch1' | 'batch2' | 'raise'; keys1: string[]; keys2?: string[]; admit?: boolean; width?: number }
const LABEL = new Map([['p1', 'pass'], ['p2', 'fail'], ['u1', 'yes'], ['u2', 'no']]);

export class Case {
  readonly base: string;
  readonly root: string;
  readonly scored: string;
  readonly knobs: string;
  readonly b: 'batch1' | 'batch2' | 'raise';
  readonly n: '1' | '2' | 'raise';
  readonly keys: string[];
  private readonly pids = new Set<number>();
  private readonly sizes = new Map<string, number>();
  private calls = 0;

  constructor(o: CaseOpts) {
    this.b = o.b ?? 'batch1';
    this.n = this.b === 'batch1' ? '1' : this.b === 'batch2' ? '2' : 'raise';
    this.base = fwd(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `z0b-${o.name}-`))));
    [this.root, this.scored, this.knobs] = ['root', 'scored', 'knobs'].map((d) => `${this.base}/${d}`);
    const keys2 = o.keys2 ?? ['qa', 'qb'];
    this.keys = this.b === 'raise' ? [...o.keys1, ...keys2] : this.b === 'batch1' ? o.keys1 : keys2;
    fs.mkdirSync(this.knobs, { recursive: true });
    fs.mkdirSync(this.scored, { recursive: true });
    for (const f of ['s4-batch.sh', 's4-units.sh', 's4-procs.ps1']) fs.copyFileSync(path.join(LAUNCH, f), path.join(this.scored, f));
    for (const f of ['s4-run.ps1', 's4-regrade.ps1', 'ab-run.mjs', 'z0-regrade.mjs']) fs.copyFileSync(path.join(__dirname, f), path.join(this.scored, f));
    put(`${this.base}/repos.json`, JSON.stringify(Object.fromEntries([...o.keys1, ...keys2].map((k, i) => [k, { toolchain: i % 2 === 0 ? 'node' : 'python' }]))));
    put(`${this.root}/pins-r4.json`, JSON.stringify({ ...PINS, batch1Keys: o.keys1.join(','), batch2Keys: keys2.join(','), wholeRunSeeds: '5', claudeVersion: '2.1.288' }));
    put(`${this.root}/spend-basis.json`, JSON.stringify({ schema: 'z0-spend-basis/1', basisByArm: BASIS, bySequence: { ...SEQ, ...BATCH2_SEQ }, meanPerRecord: MEAN }));
    put(`${this.root}/pilot.json`, JSON.stringify({ schema: 'z0-pilot/1', attempt: 1, tag: 'z0-r4-freeze-1', r: { S1: 1, S2: 1 }, rArm: 'S2', rMax: 1, flag19: false, ledgerTotal: 40, pilotSpend: 36.5, checks: {} }));
    put(`${this.root}/prices.json`, JSON.stringify(PRICES_BY_MODEL));
    if (o.admit !== false) put(`${this.root}/${this.b}/ADMITTED`, 'admitted\n');
    if (o.width !== undefined) put(`${this.root}/width.txt`, `${o.width}\n`);
  }

  knob(name: string, body: Knobs) { put(`${this.knobs}/${name}.json`, JSON.stringify(body)); }
  fx(name: string, o: FxOpts) { const dir = `${this.base}/fx/${name}`; this.sizes.set(dir, makeFixture(dir, o).length); return dir; }
  size(fixture: string) { return this.sizes.get(fixture)!; }
  dir(name: string) { return `${this.root}/${this.b}/${name}`; }
  track(pid: number) { this.pids.add(pid); }

  /** A unit folder as a finished (count null) or cut-short runner left it. */
  async plant(name: string, fxDir: string, count: number | null = null) {
    const dir = this.dir(name);
    await replay(fxDir, `${dir}/run`, count);
    put(`${dir}/run.log`, count === null ? `\nRecords: ${path.join(`${dir}/run`, 'runs.jsonl')}\n` : 'the stub run was cut short\n');
    return dir;
  }

  /** Every G5 call of a unit folder done, its labels filled and its grading.json written. */
  g5Done(dir: string) {
    const summary = [
      ['regrade', 'repro: regraded 3 cells (0 with errors), skipped 0 done ones; wrote 3'], ['reader-draw', 'reader round 1: drew 2 pairs'], ['stored-draw', 'stored sample: drew 2 units'],
      ['reader-score', 'reader round 1: 0 of 2 labels disagree'], ['stored-score', 'stored sample: 2 of 2 labels agree with the key-phrase judgement'], ['grading', `wrote ${dir}/run/grading.json: 0 flipped lessons, 0 acceptance flips`],
    ];
    for (const [call, line] of summary) put(`${dir}/g5-${call}.log`, `${line}\n`);
    const g5 = `${dir}/run/g5`;
    put(`${g5}/sealed/reader-r1.key.json`, JSON.stringify({ pairs: [{ file: 'p1', which: 'first', verdict: 'pass' }, { file: 'p2', which: 'final', verdict: 'fail' }] }));
    put(`${g5}/sealed/reader-r1.score.json`, JSON.stringify({ labels: { p1: 'pass', p2: 'fail' } }));
    put(`${g5}/sealed/stored.key.json`, JSON.stringify({ units: ['u1', 'u2'] }));
    put(`${g5}/reader-r1/labels.tsv`, '# id\tlabel (stub)\tnote\np1\tpass\t\np2\tfail\t\n');
    put(`${g5}/stored/labels.tsv`, '# id\tlabel (stub)\tnote\nu1\tyes\t\nu2\tno\t\n');
    put(`${dir}/run/grading.json`, `${JSON.stringify({ g5: { readerRound: 1 }, readerSample: { n: 2, disagreements: 0 }, flippedLessons: [], acceptanceFlips: 0 })}\n`);
  }

  /** The operator's step: every empty label in the unit folders' two labels files gets the stub's answer. */
  fillLabels(names: string[]) {
    for (const name of names) {
      for (const f of ['reader-r1', 'stored']) {
        const file = `${this.dir(name)}/run/g5/${f}/labels.tsv`;
        put(file, read(file).replace(/^(\S+)\t\t/gm, (_m, id: string) => `${id}\t${LABEL.get(id)}\t`));
      }
    }
  }

  env(extra: Record<string, string> = {}) {
    return { ...process.env, Z0_STUB_KNOBS: this.knobs, Z0_REPOS_FILE: `${this.base}/repos.json`, Z0_GRACE_S: '4', Z0_BOX_WAIT_S: '2', Z0_REAL_CHECKOUT: CHECKOUT, ...extra };
  }

  /** One s4-batch.sh call; output goes to a file so no pipe stays open behind a runner. */
  start(extra: string[] = [], env: Record<string, string> = {}, root = this.root, n: string = this.n): Started {
    const out = `${this.base}/out-${++this.calls}.txt`;
    const fd = fs.openSync(out, 'w');
    const child = spawn(gitBash(process.env, []), [`${this.scored}/s4-batch.sh`, n, CHECKOUT, root, '--poll', '1', ...extra], { env: this.env(env), stdio: ['ignore', fd, fd], windowsHide: true, cwd: this.base });
    fs.closeSync(fd);
    this.track(child.pid!);
    const done = new Promise<Run>((resolve) => child.on('exit', (code) => {
      const text = read(out).trim();
      resolve({ code, out: text, last: text.split('\n').at(-1) ?? '' });
    }));
    return { child, done };
  }
  run(extra: string[] = [], env: Record<string, string> = {}) { return this.start(extra, env).done; }

  log(b = this.b) { return lines(`${this.root}/${b}/batch.log`).map((l) => l.replace(/^\d\d-\d\d \d\d:\d\d:\d\d /, '')); }
  /** The `launch <folder> pid <pid> <flags>` lines, in order. */
  launches(b = this.b) { return this.log(b).filter((l) => l.startsWith('launch ')).map((l) => l.split(' ')[1]); }
  launcherPid(name: string) { return Number(this.log().find((l) => l.startsWith(`launch ${name} pid `))!.split(' ')[3]); }
  flags(name: string): Record<string, string> { return json(`${this.dir(name)}/launcher-args.json`); }
  markers(b = this.b) { const d = `${this.root}/${b}/done`; return fs.existsSync(d) ? fs.readdirSync(d).sort() : []; }
  marker(name: string) { return read(`${this.dir('done')}/${name}`); }
  runnerPids(b = this.b) { return lines(`${this.root}/${b}/pids.txt`).map((l) => Number(l.split(' ')[1])); }

  /** Stops every process this case started (batches, launchers, runners, regrade stubs), then removes its folder. */
  cleanup() {
    const found = [...this.pids, ...this.runnerPids(), ...lines(`${this.root}/${this.b}/regrade-pids.txt`).map((l) => Number(l.split(' ')[1]))];
    for (const l of this.log()) if (l.startsWith('launch ')) found.push(Number(l.split(' ')[3]));
    for (const pid of found) if (Number.isInteger(pid) && pid > 4) kill(pid, true);
    fs.rmSync(this.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
