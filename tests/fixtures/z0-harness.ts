// Shared set-up for the Z0 surface, void and leak tests: temp homes, a fixture repo, spec builders and record readers.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAll, validateTasks } from '../../scripts/token-eval/ab-run.mjs';
import { pathKey } from '../../scripts/token-eval/exec.mjs';
import type { Z0Record, Z0PlanCell } from './z0-contract';

export const FAKE = resolve(__dirname, 'fake-claude.mjs');
export const CLAUDE = `"${process.execPath}" "${FAKE}"`;
export const CHECKS = resolve(__dirname, 'z0-checks');
const PATH_KEY = pathKey(process.env);
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'HIPPO_HOME', PATH_KEY, 'FAKE_CLAUDE_LOG', 'FAKE_CLAUDE_LIMIT_ONCE', 'FAKE_CLAUDE_LIMIT_ALWAYS', 'FAKE_WT_DIR', 'Z0_ANCESTOR_STOP', 'GIT_CONFIG_GLOBAL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const savedCwd = process.cwd();
const dirs: string[] = [];
const pids: string[] = [];

/** For afterEach: cwd, env and temp dirs back, and any grandchild a hung fake left behind killed. */
export function cleanup() {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (pids.length) {
    const f = pids.pop()!;
    if (!existsSync(f)) continue;
    const pid = Number(readFileSync(f, 'utf8'));
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) throw err;
    }
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
}

export const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** Temp HOME, USERPROFILE, APPDATA, HIPPO_HOME and cwd, and a fresh fake-Claude log; returns the out dir and the log path. */
export function isolate(name: string) {
  const home = tmp(`z0-surf-home-${name}-`);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  process.env.HIPPO_HOME = tmp('z0-surf-hippo-');
  process.chdir(tmp('z0-surf-cwd-'));
  const out = tmp(`z0-surf-out-${name}-`);
  const logDir = tmp('z0-surf-log-');
  process.env.FAKE_CLAUDE_LOG = join(logDir, 'fake.log');
  pids.push(join(out, 'grandchild.pid'));
  return { out, log: join(logDir, 'fake.log'), home };
}

export interface FixtureRepo { repo: string; base: string; fix: string }

export function makeRepo(extra: Record<string, string> = {}): FixtureRepo {
  const repo = tmp('z0-surf-repo-');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFile(repo, 'lib.js', 'module.exports.add = (a, b) => a - b;\n');
  for (const [f, text] of Object.entries(extra)) writeFile(repo, f, text);
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFile(repo, 'lib.js', 'module.exports.add = (a, b) => a + b;\n');
  writeFile(repo, 'test.js', "const { add } = require('./lib.js');\nif (add(2, 3) !== 5) process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'fix');
  return { repo, base, fix: git('rev-parse', 'HEAD') };
}

function writeFile(dir: string, rel: string, text: string) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

export interface LessonDef { id: string; rule: string; reason: string; keyPhrase: string; check: { script: string; args: string[] }; supersedes?: string; keyPhraseAllowed?: boolean }
export interface FamilyDef { id: string; sequence: string; lessonSource: string; lessons: LessonDef[]; screen: object }
export interface TaskDef {
  id: string; kind: string; baseRef: string; fixRef: string; prompt: string; testFiles: string[]; test: string;
  familyId?: string; lessonId?: string; setup?: string; keyPhraseAllowed?: boolean;
}
export const lesson = (id: string, rule: string, extra: Partial<LessonDef> = {}): LessonDef => ({ id, rule, reason: `the ${id} checker reads it`, keyPhrase: `zq-${id}`, check: { script: 'lesson.mjs', args: [] }, ...extra });
export const family = (id: string, lessons: LessonDef[]): FamilyDef => ({ id, sequence: 'seqF', lessonSource: 'maintainer', lessons, screen: { id: `${id}-screen`, baseRef: 'x', fixRef: 'x', prompt: 'screen', test: 'node test.js', testFiles: [] } });
export const task = (r: FixtureRepo, id: string, prompt: string, extra: Partial<TaskDef> = {}): TaskDef => ({ id, kind: 'no-lesson', baseRef: r.base, fixRef: r.fix, prompt, testFiles: ['test.js'], test: 'node test.js', ...extra });
export const teach = (r: FixtureRepo, id: string, lessonId: string, prompt: string, extra: Partial<TaskDef> = {}) => task(r, id, prompt, { kind: 'teach', familyId: lessonId.split('-')[0], lessonId, ...extra });
export const apply = (r: FixtureRepo, id: string, lessonId: string, prompt: string, extra: Partial<TaskDef> = {}) => task(r, id, prompt, { kind: 'apply', familyId: lessonId.split('-')[0], lessonId, ...extra });
export const plain = (r: FixtureRepo, id: string) => task(r, id, 'look around only');
export const spec = (r: FixtureRepo, families: FamilyDef[], tasks: TaskDef[]) => validateTasks({ families, sequences: [{ id: 'seqF', cluster: 'c', repo: r.repo, fixedOrder: true, tasks }] }, CHECKS);
/** One lesson family f1 with lesson f1-l1: teach t1, two plain tasks, applies a1 and a2; prompts override per task. */
export function oneLesson(r: FixtureRepo, prompts: Record<string, string> = {}, extra: Partial<LessonDef> = {}) {
  const p = (id: string) => prompts[id] ?? 'look around only';
  return spec(r, [family('f1', [lesson('f1-l1', 'Write the lesson file', extra)])], [
    teach(r, 't1', 'f1-l1', p('t1')), task(r, 'n1', p('n1')), task(r, 'n2', p('n2')), apply(r, 'a1', 'f1-l1', p('a1')), apply(r, 'a2', 'f1-l1', p('a2')),
  ]);
}

export interface RunExtra { limitWaitMs?: number; limitMaxWaits?: number; sessionTimeoutMs?: number; canaries?: string[]; log?: (m: string) => void }
export async function run(s: ReturnType<typeof spec>, arms: string[], out: string, extra: RunExtra = {}) {
  return runAll({ spec: s, arms, seeds: 1, outDir: out, model: null, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {}, ...extra });
}

const jsonl = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export interface VoidHit { reason: string; class: string | null; tool: string | null; path: string | null; file: string | null }
/** A record with the runner's fields beyond the z0-record/1 contract. */
export type RunRecord = Z0Record & { voidHits?: VoidHit[]; turnsSource?: string };
export const readRecords = (out: string): RunRecord[] => jsonl<RunRecord>(join(out, 'runs.jsonl'));
export const readPlan = (out: string): Z0PlanCell[] => JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'));
export interface LedgerEntry { path: string; sha256?: string; size?: number; link?: true; error?: string }
export interface LedgerLine {
  schema: string; runName: string; sequence: string; arm: string; seed: number; position: number; order: number; taskId: string; when: string;
  verified: boolean | null; restorable: boolean | null; copyErrors: { surface: string; code: string }[]; surfaces: Record<string, LedgerEntry[]>;
  rows?: { prefix: string; global: boolean; chars: number }[];
}
export const readLedger = (out: string): LedgerLine[] => jsonl<LedgerLine>(join(out, 'ledger.jsonl'));
export const logLines = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
/** The fake's whole result JSON for a session (`<id>.json`) or its resume (`<id>.resume.json`). */
export const rawResult = (out: string, arm: string, name: string) => JSON.parse(readFileSync(join(out, 'raw', 'seqF', arm, 'seed1', name), 'utf8'));
export const find = <T extends Z0Record>(recs: T[], arm: string, id: string): T => recs.find((x) => x.arm === arm && x.taskId === id)!;
export const runRoot = (out: string, arm: string) => join(out, 'runs', 'seqF', arm, 'seed1');
export const workDir = (out: string, arm: string) => join(runRoot(out, arm), 'work');
