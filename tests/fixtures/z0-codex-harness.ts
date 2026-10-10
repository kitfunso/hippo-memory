// Set-up for the Z0 Codex tests: a temp operator with a fake real codex and a login, and a Codex ctx and run built on them.
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { codexContext, writeCodexHome } from '../../scripts/token-eval/codex.mjs';
import { runDirs, freshRunDirs } from '../../scripts/token-eval/homes.mjs';
import { armEnv } from '../../scripts/token-eval/arms.mjs';
import { pathKey } from '../../scripts/token-eval/exec.mjs';
import { runAll, validateTasks } from '../../scripts/token-eval/ab-run.mjs';
import { tmp, isolate, readRecords, CHECKS, CLAUDE, family, lesson, teach, apply } from './z0-harness.js';
import type { FixtureRepo, FamilyDef, TaskDef, RunExtra, RunRecord } from './z0-harness.js';

export const FAKE_CODEX = resolve(__dirname, 'fake-codex.mjs');
const WIN = process.platform === 'win32';

export interface Operator { home: string; bin: string; launcher: string; authFile: string; tokens: string[]; env: Record<string, string | undefined> }

/** An operator HOME with a fake real codex on its own PATH dir and a Codex login whose tokens the test knows. */
export function operator(name: string): Operator {
  const home = tmp(`z0-codex-op-${name}-`);
  const bin = join(home, 'npm');
  mkdirSync(bin, { recursive: true });
  const launcher = WIN ? join(bin, 'codex.cmd') : join(bin, 'codex');
  if (WIN) writeFileSync(launcher, `@"${process.execPath}" "${FAKE_CODEX}" %*\r\n`);
  else writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`, { mode: 0o755 });
  const tokens = ['id', 'access', 'refresh'].map((k) => `zq-${k}-${randomUUID()}`);
  const auth = { OPENAI_API_KEY: null, tokens: { id_token: tokens[0], access_token: tokens[1], refresh_token: tokens[2], account_id: 'acct-0000' }, last_refresh: '2026-10-01T00:00:00Z' };
  const authFile = join(home, '.codex', 'auth.json');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(authFile, JSON.stringify(auth, null, 2));
  const env = { ...process.env, HOME: home, USERPROFILE: home, [pathKey(process.env)]: bin };
  return { home, bin, launcher, authFile, tokens, env };
}

/** Turn the operator launcher into hippo's wrapper, as `hippo hook install codex` leaves it; running it writes `wrapper-ran.txt`. */
export function wrapOperator(op: Operator, { metadata = true }: { metadata?: boolean } = {}) {
  const real = op.launcher.replace(/(\.cmd)?$/, WIN ? '.hippo-real.cmd' : '.hippo-real');
  renameSync(op.launcher, real);
  const sentinel = join(op.home, 'wrapper-ran.txt');
  if (WIN) writeFileSync(op.launcher, `@echo off\r\nREM hippo codex wrapper\r\necho ran> "${sentinel}"\r\n"${real}" %*\r\n`);
  else writeFileSync(op.launcher, `#!/bin/sh\n# hippo codex wrapper\necho ran > "${sentinel}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  if (metadata) {
    mkdirSync(join(op.home, '.hippo', 'integrations'), { recursive: true });
    writeFileSync(join(op.home, '.hippo', 'integrations', 'codex.json'), JSON.stringify({ realCodexPath: real, originalCodexPath: op.launcher, commandPath: op.launcher, backupPath: real }));
  }
  return { real, sentinel };
}

export interface CodexOpts { codexModel?: string | null; codexHookTrust?: string; codexMemoryWait?: string; codexMemories?: string; codexTokenFiles?: string[]; codexInternalSources?: string[]; codexWrapperWaitMs?: number }

/** A ctx holding only what a Codex session reads: the codexContext fields plus the limit and timeout settings. */
export function codexCtx(op: Operator, opts: CodexOpts = {}, extra: { sessionTimeoutMs?: number; limitMaxWaits?: number } = {}) {
  const fields = codexContext({ codexBin: op.launcher, codexAuth: op.authFile, codexModel: 'gpt-fake', codexMemoryWait: 'none', ...opts }, op.env);
  return { ...fields, sessionTimeoutMs: extra.sessionTimeoutMs ?? 60_000, limitWaitMs: 0, limitMaxWaits: extra.limitMaxWaits ?? 2, log: () => {} };
}

export type CodexCtx = ReturnType<typeof codexCtx>;

/** A fresh run for `arm` under `out`: homes, a git work tree, the arm env (with a Claude token to strip) and the Codex home. */
export function codexRun(ctx: CodexCtx, out: string, arm = 'X1', seed = 1) {
  const dirs = runDirs(out, 'seqX', arm, seed);
  freshRunDirs(dirs);
  execFileSync('git', ['init', '-q'], { cwd: dirs.work });
  const env = armEnv(arm, dirs, { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'zq-claude-token-0000' });
  const rawDir = join(out, 'raw', 'seqX', arm, `seed${seed}`);
  mkdirSync(rawDir, { recursive: true });
  const run = { s: { id: 'seqX' }, arm, seed, dirs, env, rawDir, codexLauncher: '' };
  writeCodexHome(ctx, run);
  return run;
}

export const xTask = (prompt: string, id = 'a1') => ({ id, prompt });

/** A set X tasks file on sequence seqF, so the z0-harness readers (runRoot, rawResult) find its runs. */
export const xSpec = (r: FixtureRepo, families: FamilyDef[], tasks: TaskDef[]) =>
  validateTasks({ families, sequences: [{ id: 'seqF', cluster: 'c', repo: r.repo, fixedOrder: true, set: 'X', tasks }] }, CHECKS);

/** isolate() plus an operator and the fake-codex log and limit-state files, each in its own temp dir. */
export function xIsolate(name: string) {
  const { out, log, home } = isolate(name);
  const op = operator(name);
  const codexLog = join(tmp('z0-xlog-'), 'codex.log');
  process.env.FAKE_CODEX_LOG = codexLog;
  process.env.FAKE_CODEX_STATE = join(tmp('z0-xstate-'), 'limit');
  return { out, log, home, op, codexLog };
}

export const X_IDS = ['xa', 'xb', 'xc'];
const xFamily = (id: string) => family(id, [lesson(`${id}-l1`, `Rule ${id} holds`)]);

/** The smallest set X order the draw accepts (two tasks between a teach and its first apply, no no-lesson filler): t-x*, a-x*, b-x*. */
export function xTrio(r: FixtureRepo, prompts: Record<string, string> = {}) {
  const at = (id: string) => prompts[id] ?? 'look';
  const tasks = [
    ...X_IDS.map((id) => teach(r, `t-${id}`, `${id}-l1`, at(`t-${id}`))),
    ...X_IDS.map((id) => apply(r, `a-${id}`, `${id}-l1`, at(`a-${id}`))),
    ...X_IDS.map((id) => apply(r, `b-${id}`, `${id}-l1`, at(`b-${id}`))),
  ];
  return xSpec(r, X_IDS.map(xFamily), tasks);
}

/** runAll over fake-claude teaches and fake-codex applies, with the operator's launcher and login and no memory wait. */
export async function xRun(s: ReturnType<typeof xSpec>, arms: string[], out: string, op: Operator, extra: RunExtra & CodexOpts = {}) {
  return runAll({
    spec: s, arms, seeds: 1, outDir: out, model: null, claudeBin: CLAUDE, settleMs: 0, warmup: false, log: () => {},
    codexBin: op.launcher, codexAuth: op.authFile, codexModel: 'gpt-fake', codexMemoryWait: 'none', ...extra,
  });
}

export interface FakeSeen { argv: string[]; cwd: string; envKeys: string[]; home: string; appdata: string; codexHome: string; config: string | null; agents: string | null; authSha: string | null }
export const fakeSeen = (log: string): FakeSeen[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A set X record with the Codex fields the runner adds. */
export type XRecord = RunRecord & {
  codexVersion?: string; codexMemories?: boolean; codexHookTrust?: string; codexAuth?: string; codexMemoryWait?: { ms: number; timedOut: boolean };
  codexHooksFired?: { sent: number; injections: number } | null; codexInternalHooksFired?: { sent: number; injections: number } | null; codexWrapperCaptured?: boolean | null;
  codexWrapperWait?: { ms: number; timedOut: boolean; end: string | null } | null; codexStrayRollouts?: number; codexInternalUsage?: { usage: Record<string, number> } | null; x4Block?: string; wallMs?: number;
  chain?: { stored: boolean | null; shown: boolean | null; captured: boolean | null; capturedAny: boolean | null };
};

export function xRecords(out: string): XRecord[] {
  // SAFETY: a set X run writes RunRecord lines that also hold the Codex fields XRecord adds.
  return readRecords(out) as XRecord[];
}

/** Vault dirs in the temp dir that still hold any of `tokens`; other test files open vaults too, so a dir may vanish mid-read. */
export function vaultsHolding(tokens: string[]): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(tmpdir()).filter((n) => n.startsWith('z0-codex-auth-'))) {
    try {
      if (tokens.some((t) => readFileSync(join(tmpdir(), name, 'auth.json')).includes(t))) hits.push(name);
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err;
    }
  }
  return hits;
}

/** Every file under `dir` whose bytes hold any of `needles`, as paths relative to `dir`. */
export function filesHolding(dir: string, needles: string[]): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (needles.some((n) => readFileSync(p).includes(n))) hits.push(p.slice(dir.length + 1));
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}
