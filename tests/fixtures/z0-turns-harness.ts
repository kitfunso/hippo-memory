// Shared setup for the three token-eval-z0-turns-*.test.ts files: a fixture repo, the fake Claude Code and the record readers.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, vi } from 'vitest';
import { runAll, validateTasks } from '../../scripts/token-eval/ab-run.mjs';
import type { Z0Record, Z0PlanCell } from './z0-contract.js';

export const FAKE = resolve(__dirname, 'fake-claude.mjs');
export const CLAUDE = `"${process.execPath}" "${FAKE}"`;
export const CHECKS = resolve(__dirname, 'z0-checks');
const dirs: string[] = [];
const savedCwd = process.cwd();
export function cleanup() {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
}

export const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** Temp HOME, USERPROFILE, APPDATA and cwd, and a fresh fake-Claude log; returns the out dir and the log path. */
export function isolate(name: string) {
  const home = tmp(`z0-turns-home-${name}-`);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('APPDATA', join(home, 'AppData', 'Roaming'));
  process.chdir(tmp('z0-turns-cwd-'));
  const out = tmp(`z0-turns-out-${name}-`);
  const log = join(tmp('z0-turns-log-'), 'fake.log');
  vi.stubEnv('FAKE_CLAUDE_LOG', log);
  return { out, log };
}

export interface FixtureRepo { repo: string; base: string; fix: string }

export function makeRepo(): FixtureRepo {
  const repo = tmp('z0-turns-repo-');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a - b;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'lib.js'), 'module.exports.add = (a, b) => a + b;\n');
  writeFileSync(join(repo, 'test.js'), "const { add } = require('./lib.js');\nif (add(2, 3) !== 5) process.exit(1);\n");
  git('add', '.');
  git('commit', '-qm', 'fix');
  return { repo, base, fix: git('rev-parse', 'HEAD') };
}

export interface LessonDef { id: string; rule: string; reason: string; keyPhrase: string; check: { script: string; args: string[] }; supersedes?: string }
export interface FamilyDef { id: string; sequence: string; lessonSource: string; lessons: LessonDef[]; screen: object }
export interface TaskDef {
  id: string; kind: string; baseRef: string; fixRef: string; prompt: string; testFiles: string[]; test: string;
  familyId?: string; lessonId?: string; setup?: string;
}
export interface RunExtra { limitWaitMs?: number; limitMaxWaits?: number; sessionTimeoutMs?: number; pins?: Record<string, string>; log?: (m: string) => void }
/** What the toy lesson checker logs per call; the probe fields appear only with its `probe` arg. */
export interface CheckLine {
  lesson: string; pre: string; post: string; preRef: string | null; commands: string[]; resume: string[] | null; has?: boolean;
  head?: string; symbolic?: string | null; logAll?: string; reflog?: string | null; refs?: string;
}
export const lesson = (id: string, rule: string, extra: Partial<LessonDef> = {}): LessonDef => ({ id, rule, reason: `the ${id} checker reads it`, keyPhrase: `zq-${id}`, check: { script: 'lesson.mjs', args: [] }, ...extra });
export const family = (id: string, lessons: LessonDef[]): FamilyDef => ({ id, sequence: 'seqF', lessonSource: 'maintainer', lessons, screen: { id: `${id}-screen`, baseRef: 'x', fixRef: 'x', prompt: 'screen', test: 'node test.js', testFiles: [] } });
export const task = (r: FixtureRepo, id: string, prompt: string, extra: Partial<TaskDef> = {}): TaskDef => ({ id, kind: 'no-lesson', baseRef: r.base, fixRef: r.fix, prompt, testFiles: ['test.js'], test: 'node test.js', ...extra });
export const teach = (r: FixtureRepo, id: string, lessonId: string, prompt: string, extra: Partial<TaskDef> = {}) => task(r, id, prompt, { kind: 'teach', familyId: lessonId.split('-')[0], lessonId, ...extra });
export const apply = (r: FixtureRepo, id: string, lessonId: string, prompt: string, extra: Partial<TaskDef> = {}) => task(r, id, prompt, { kind: 'apply', familyId: lessonId.split('-')[0], lessonId, ...extra });
export const plain = (r: FixtureRepo, id: string) => task(r, id, 'look around only');
export interface Spec { families: FamilyDef[]; sequences: Array<{ id: string; cluster: string; repo: string; fixedOrder: boolean; tasks: TaskDef[] }> }
export const spec = (r: FixtureRepo, families: FamilyDef[], tasks: TaskDef[]): Spec => validateTasks({ families, sequences: [{ id: 'seqF', cluster: 'c', repo: r.repo, fixedOrder: true, tasks }] }, CHECKS);
/** The usual reversal family: f1-l1 then f1-l2 superseding it. */
export const reversal = (l1: Partial<LessonDef> = {}, l2: Partial<LessonDef> = {}) => family('f1', [lesson('f1-l1', 'Write the lesson file', l1), lesson('f1-l2', 'Write the lesson file twice', { supersedes: 'f1-l1', ...l2 })]);

export async function run(s: ReturnType<typeof spec>, arms: string[], out: string, extra: RunExtra = {}) {
  return runAll({ spec: s, arms, seeds: 1, outDir: out, model: null, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {}, ...extra });
}
export const readRecords = (out: string): Z0Record[] => readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
export const readPlan = (out: string): Z0PlanCell[] => JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'));
export const logLines = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
export const checkLog = (log: string): CheckLine[] => logLines(log).filter((l) => l.startsWith('check ')).map((l) => JSON.parse(l.slice(6)));
export const seen = (out: string, arm: string, id: string): Record<string, string> => JSON.parse(readFileSync(join(out, 'raw', 'seqF', arm, 'seed1', `${id}.json`), 'utf8')).files;
export const find = (recs: Z0Record[], arm: string, id: string) => recs.find((x) => x.arm === arm && x.taskId === id)!;
export const workDir = (out: string, arm: string) => join(out, 'runs', 'seqF', arm, 'seed1', 'work');
export const ZERO = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
export const INVALID_NULLS: readonly (keyof Z0Record)[] = ['usage', 'costUsd', 'turns', 'toolCalls', 'fileReads', 'wallMs', 'teachTurns', 'correctionTurns', 'acceptancePassed', 'teachForm'];

export function expectInvalid(r: Z0Record, reason: string) {
  expect(r.invalid, r.taskId).toBe(reason);
  for (const f of INVALID_NULLS) expect(r[f], `${r.taskId} ${String(f)}`).toBeNull();
  expect(r).toMatchObject({ lessons: [], resolved: false, void: null });
  expect([true, false]).toContain(r.timedOut);
  expect([true, false]).toContain(r.leak);
  expect(Number.isInteger(r.limitRetries)).toBe(true);
}
