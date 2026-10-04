// One shared fake run for the G5 regrade tests: checkers follow env vars, and each test regrades its own copy of the out dir.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTasks } from '../../scripts/token-eval/ab-run.mjs';
import { CHECKS, apply, isolate, lesson, makeRepo, plain, run, teach, tmp, type FamilyDef, type FixtureRepo, type TaskDef } from './z0-harness';

export const TOKEN = 'z0-dummy-oauth-token';
export const PASS_ENV = ['Z0_TOGGLE', 'Z0_ENV_DUMP_DIR'];
const script = (name: string) => join(CHECKS, name);
const CLI = fileURLToPath(new URL('../../scripts/token-eval/z0-regrade.mjs', import.meta.url));
const fam = (id: string, lessons: FamilyDef['lessons']): FamilyDef => ({ id, sequence: 'seqF', lessonSource: 'maintainer', lessons, screen: { id: `${id}-screen`, baseRef: 'x', fixRef: 'x', prompt: 'screen', test: 'node test.js', testFiles: [] } });

export interface RawSpec { families: FamilyDef[]; sequences: { id: string; cluster: string; repo: string; fixedOrder: boolean; tasks: TaskDef[] }[] }
export interface Shared { out: string; raw: RawSpec; dumps: string; r: FixtureRepo }

/** f1-l1 follows Z0_TOGGLE and is the stale lesson of a4; f2-l1 dumps its env; a1's acceptance follows Z0_TOGGLE_TEST and its chain is shown. */
export function regradeSpec(r: FixtureRepo): RawSpec {
  const toggle = { script: script('toggle.mjs'), args: [] };
  const families = [
    fam('f1', [lesson('f1-l1', 'Write the lesson file', { check: toggle }), lesson('f1-l2', 'Write the lesson file twice', { supersedes: 'f1-l1', check: { script: script('lesson.mjs'), args: [] } })]),
    fam('f2', [lesson('f2-l1', 'Keep the lesson file short', { check: { script: script('env-dump.mjs'), args: [] } })]),
  ];
  const tasks = [
    teach(r, 't1', 'f1-l1', 'LESSON_OK'), teach(r, 't2', 'f2-l1', 'LESSON_OK'), plain(r, 'n1'),
    apply(r, 'a1', 'f1-l1', 'LESSON_OK\nECHO:zq-f1-l1', { keyPhraseAllowed: true, test: `node "${script('toggle.mjs')}" var=Z0_TOGGLE_TEST` }),
    teach(r, 't3', 'f1-l2', 'LESSON_OK'), apply(r, 'a2', 'f2-l1', 'LESSON_OK'), apply(r, 'a3', 'f2-l1', 'LESSON_OK'), apply(r, 'a4', 'f1-l2', 'LESSON_OK'),
  ];
  return { families, sequences: [{ id: 'seqF', cluster: 'c', repo: r.repo, fixedOrder: true, tasks }] };
}

/** The run every test in a file regrades: arm A0, one seed, a dummy token and the toggles at their run values. */
export async function sharedRun(name: string): Promise<Shared> {
  const { out } = isolate(name);
  const r = makeRepo();
  const dumps = tmp('z0-rg-dumps-');
  Object.assign(process.env, { Z0_TOGGLE: 'run', Z0_ENV_DUMP_DIR: dumps, CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  const raw = regradeSpec(r);
  await run(validateTasks(structuredClone(raw), CHECKS), ['A0'], out, { passEnv: PASS_ENV });
  return { out, raw, dumps, r };
}

/** A fresh copy of the shared out dir plus a tasks file; `edit` changes the copy's spec (a swapped checker, a setup). */
export function copyOut(shared: Shared, edit: (s: RawSpec) => void = () => {}) {
  const out = tmp('z0-rg-out-');
  cpSync(shared.out, out, { recursive: true });
  const raw = structuredClone(shared.raw);
  edit(raw);
  const tasks = join(out, 'tasks.json');
  writeFileSync(tasks, JSON.stringify(raw));
  return { out, tasks };
}

export const taskOf = (s: RawSpec, id: string) => s.sequences[0].tasks.find((t) => t.id === id)!;
export const lessonOf = (s: RawSpec, id: string) => s.families.flatMap((f) => f.lessons).find((l) => l.id === id)!;

export interface CliResult { code: number; stdout: string; stderr: string }

/** The CLI in a child process with env vars for the call only (undefined unsets one); a long in-process regrade starved vitest's worker RPC. */
export function cli(argv: string[], env: Record<string, string | undefined> = {}): Promise<CliResult> {
  const childEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const [out, err]: Buffer[][] = [[], []];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

export const regrade = (c: { out: string; tasks: string }, extra: string[] = [], env: Record<string, string | undefined> = {}) => cli(['regrade', '--out', c.out, '--tasks', c.tasks, ...extra], env);
export const grading = (out: string, extra: string[] = []) => cli(['grading', '--out', out, ...extra]);

export interface Row { key: string; taskId: string; status: string; error: { stage: string; message: string } | null; checks: { lessonId: string; which: string; saved: unknown; regraded: unknown; second?: unknown; flip: boolean; reason: string | null; checkerSha: string }[]; acceptance: { saved: boolean; regraded: boolean; flip: boolean; reason: string | null } | null; inputsHash: string; extraEnvKeys: string[] }
export const rowsOf = (out: string, pass: 'repro' | 'postfix' = 'repro'): Row[] => {
  const f = join(out, 'g5', pass === 'postfix' ? 'regrade.postfix.jsonl' : 'regrade.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
export const rowFor = (out: string, taskId: string, pass: 'repro' | 'postfix' = 'repro') => rowsOf(out, pass).filter((r) => r.taskId === taskId).at(-1)!;
const ORDER = ['t1', 't2', 'n1', 'a1', 't3', 'a2', 'a3', 'a4'];
export const keyOf = (taskId: string) => `seqF#1@${ORDER.indexOf(taskId)}/A0`;
export const readGrading = (out: string) => JSON.parse(readFileSync(join(out, 'grading.json'), 'utf8'));
export const dumpsIn = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
