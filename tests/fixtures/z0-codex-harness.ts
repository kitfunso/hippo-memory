// Set-up for the Z0 Codex tests: a temp operator with a fake real codex and a login, and a Codex ctx and run built on them.
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { codexContext, writeCodexHome } from '../../scripts/token-eval/codex.mjs';
import { runDirs, freshRunDirs } from '../../scripts/token-eval/homes.mjs';
import { armEnv } from '../../scripts/token-eval/arms.mjs';
import { pathKey } from '../../scripts/token-eval/exec.mjs';
import { tmp } from './z0-harness.js';

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

export interface CodexOpts { codexModel?: string | null; codexHookTrust?: string; codexMemoryWait?: string; codexMemories?: string; codexTokenFiles?: string[]; codexInternalSources?: string[] }

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

export interface FakeSeen { argv: string[]; cwd: string; envKeys: string[]; home: string; appdata: string; codexHome: string; config: string | null; agents: string | null; authSha: string | null }
export const fakeSeen = (log: string): FakeSeen[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

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
