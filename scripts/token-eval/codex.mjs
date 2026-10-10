// The `codex exec` session driver for set X apply tasks (E6 plan D4, D5, R1, R9, R11, R14, R15, R28): launcher, home, args and the wait.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathKey } from './exec.mjs';
import { childEnv } from './arms.mjs';
import { untilNotLimited } from './turns.mjs';
import { CODEX_INTERNAL_SOURCES, listRollouts, sessionRollouts, rolloutUsage, parseRollouts, threadIdFrom, failureText } from './codex-rollout.mjs';
import { CODEX_TOKEN_FILES, CODEX_AUTH_RE, defaultAuthFile, openAuthVault, authIn, authOut, redact, removeTokenFiles, readIfPresent } from './codex-auth.mjs';

export const WRAPPER_MARK = 'hippo codex wrapper';
export const CODEX_LIMIT_RE = /usage limit|hit your (?:usage )?limit|rate[_ ]limit|too many requests/i;
const DEFAULT_WAIT = 'poll:30000:600000';
const HOME_KEYS = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);

/** hippo's Codex session-end worker log in a run's home. */
export const wrapperLog = (run) => path.join(run.dirs.home, '.hippo', 'logs', 'codex-sleep.log');

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isBareName = (cmd) => /^[\w.-]+$/.test(cmd);

/** Whether a launcher is hippo's Codex wrapper; only the head is read, since a real codex.exe is large. */
function isWrapper(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64 * 1024);
    return head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)).toString('utf8').includes(WRAPPER_MARK);
  } finally {
    fs.closeSync(fd);
  }
}

function onPath(name, pathValue, exts) {
  for (const dir of String(pathValue ?? '').split(path.delimiter).filter(Boolean)) {
    // npm puts an extensionless sh shim beside codex.cmd, so win32 tries only the names cmd.exe can run.
    for (const ext of exts) if (fs.statSync(path.join(dir, `${name}${ext}`), { throwIfNoEntry: false })?.isFile()) return path.join(dir, `${name}${ext}`);
  }
  return null;
}

/** The real codex behind hippo's wrapper, from the operator's wrapper metadata; refuses when it cannot be named for sure. */
function unwrap(launcher, env) {
  const meta = path.join(env.HOME || env.USERPROFILE || '', '.hippo', 'integrations', 'codex.json');
  const fix = 'pass --codex-bin <path to the real codex>';
  if (!fs.existsSync(meta)) throw new Error(`${launcher} is hippo's Codex wrapper and ${meta} is missing, so the real codex is unknown; ${fix}`);
  const real = JSON.parse(fs.readFileSync(meta, 'utf8')).realCodexPath;
  if (!real || !fs.existsSync(real)) throw new Error(`${launcher} is hippo's Codex wrapper and its metadata names no real codex that exists (${real ?? 'none'}); ${fix}`);
  if (isWrapper(real)) throw new Error(`${launcher} is hippo's Codex wrapper and ${real} is a wrapper too; ${fix}`);
  return real;
}

/** The real codex every run launcher execs: from `--codex-bin` or PATH, past hippo's wrapper, never the wrapper itself (plan R1). */
export function resolveCodex(codexBin, env, platform = process.platform) {
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.bat'] : [''];
  const candidate = isBareName(codexBin) ? onPath(codexBin, env[pathKey(env)], exts) : path.resolve(codexBin);
  if (!candidate || !fs.existsSync(candidate)) throw new Error(`${codexBin} ${isBareName(codexBin) ? 'is not on PATH' : 'does not exist'}; install Codex or pass --codex-bin`);
  const real = isWrapper(candidate) ? unwrap(candidate, env) : candidate;
  return { path: real, sha256: sha256(real), wrapper: real === candidate ? null : candidate, dir: path.dirname(candidate) };
}

/** `<bin>/codex(.cmd)`, which execs the real codex: X2's install wraps this file, never the operator's. */
export function writeLauncher(binDir, real, platform = process.platform) {
  fs.mkdirSync(binDir, { recursive: true });
  if (platform === 'win32') {
    const file = path.join(binDir, 'codex.cmd');
    fs.writeFileSync(file, `@"${real}" %*\r\n`);
    return file;
  }
  const file = path.join(binDir, 'codex');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return file;
}

/** A Codex session's env: no Claude token (plan R15), the run's bin/ kept, HOME and APPDATA under `<root>/home` (plan R11). */
export function codexEnv(run) {
  const home = run.dirs.home;
  const env = Object.fromEntries(Object.entries(childEnv(run.env, { keepBin: true })).filter(([k]) => !HOME_KEYS.has(k.toUpperCase())));
  const appdata = path.join(home, 'appdata');
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: appdata, LOCALAPPDATA: appdata };
}

/** `--codex-hook-trust none|flag|file:<path>` (plan R9); file text may name the run's hooks.json as `{hooksJson}`. */
export function parseHookTrust(spec = 'none') {
  if (spec === 'none' || spec === 'flag') return { kind: spec };
  if (String(spec).startsWith('file:')) {
    const file = path.resolve(spec.slice(5));
    return { kind: 'file', path: file, text: fs.readFileSync(file, 'utf8') };
  }
  throw new Error(`--codex-hook-trust must be none, flag or file:<path>, got ${spec}`);
}

/** `--codex-memory-wait none|poll:<stableMs>:<timeoutMs>`; the poll default stands until smoke sets the wait (prereg 112). */
export function parseMemoryWait(spec = DEFAULT_WAIT) {
  if (spec === 'none') return { kind: 'none' };
  const m = /^poll:(\d+):(\d+)$/.exec(String(spec));
  if (!m) throw new Error(`--codex-memory-wait must be none or poll:<stableMs>:<timeoutMs>, got ${spec}`);
  return { kind: 'poll', stableMs: Number(m[1]), timeoutMs: Number(m[2]) };
}

export function parseCodexMemories(spec = 'on') {
  if (spec !== 'on' && spec !== 'off') throw new Error(`--codex-memories must be on or off, got ${spec}`);
  return spec === 'on';
}

/** `--codex-wrapper-wait-ms N`: how long an X2 cell waits for the end line of hippo's Codex worker; 0 reads the log once. */
export function parseWrapperWait(spec = '120000') {
  if (!/^\d+$/.test(String(spec))) throw new Error(`--codex-wrapper-wait-ms must be a whole number of milliseconds, got ${spec}`);
  return Number(spec);
}

/** The run's config.toml, the same for X1 to X4 apart from the trust path; then the run launcher. */
export function writeCodexHome(ctx, run) {
  const { codexHome, home, bin } = run.dirs;
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(home, 'appdata'), { recursive: true });
  const trust = ctx.codexHookTrust.kind === 'file' ? ctx.codexHookTrust.text.replaceAll('{hooksJson}', path.join(codexHome, 'hooks.json')) : '';
  // The file store pins the login to auth.json, so the run copy is the only one Codex reads or refreshes (plan R14).
  // Idle hours at the documented floor of 1: at the default 6, almost no apply idles long enough to feed a later one (smoke report).
  const toml = ['cli_auth_credentials_store = "file"', 'check_for_update_on_startup = false', '', trust.trimEnd(), '', '[features]', `memories = ${ctx.codexMemories}`, '', '[memories]', 'min_rollout_idle_hours = 1', ''];
  fs.writeFileSync(path.join(codexHome, 'config.toml'), toml.filter((l, i) => l !== '' || toml[i - 1] !== '').join('\n'));
  run.codexLauncher = writeLauncher(bin, ctx.codexLauncher.path);
  return run.codexLauncher;
}

/** The exact `codex exec` argv; the prompt goes on stdin (`-`). */
export function codexArgs(ctx, run) {
  if (!ctx.codexModel) throw new Error('a Codex session needs --codex-model, so every record names the model it ran');
  const args = ['exec', '--json', '--model', ctx.codexModel, '--cd', run.dirs.work, '--dangerously-bypass-approvals-and-sandbox', '--strict-config'];
  if (ctx.codexHookTrust.kind === 'flag') args.push('--dangerously-bypass-hook-trust');
  return [...args, '-'];
}

export const quoteArg = (a) => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a}"`);

/** Every file under memories/ with its size and mtime, so the wait sees a write it would miss by name alone. */
function memoryState(dir) {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => {
      const p = path.join(e.parentPath, e.name);
      const st = fs.statSync(p, { throwIfNoEntry: false });
      return `${p}|${st?.size}|${st?.mtimeMs}`;
    }).sort().join('\n');
}

/** Poll CODEX_HOME/memories until nothing changed for stableMs, or timeoutMs passed; `ms` goes in the record, never in wallMs. */
export async function memoryWait(wait, codexHome) {
  if (wait.kind === 'none') return { ms: 0, timedOut: false };
  const dir = path.join(codexHome, 'memories');
  const start = performance.now();
  const step = Math.min(1000, Math.max(50, Math.round(wait.stableMs / 10)));
  let last = memoryState(dir);
  let stableSince = start;
  for (;;) {
    await delay(step);
    const now = performance.now();
    const cur = memoryState(dir);
    if (cur !== last) {
      last = cur;
      stableSince = now;
    } else if (now - stableSince >= wait.stableMs) return { ms: Math.round(now - start), timedOut: false };
    if (now - start >= wait.timeoutMs) return { ms: Math.round(now - start), timedOut: true };
  }
}

function codexVersion(launcher, env) {
  const r = spawnSync(`${quoteArg(launcher)} --version`, { shell: true, env, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`${launcher} --version exited ${r.status}: ${(r.stderr ?? '').trim().slice(-300)}`);
  return r.stdout.trim();
}

/** The ctx fields every Codex session reads; options are checked before the vault opens, so a refused flag leaves no copy. */
export function codexContext(opts, baseEnv = process.env) {
  const fields = {
    codexModel: opts.codexModel ?? null, codexHookTrust: parseHookTrust(opts.codexHookTrust), codexMemoryWait: parseMemoryWait(opts.codexMemoryWait),
    codexMemories: parseCodexMemories(opts.codexMemories), codexTokenFiles: opts.codexTokenFiles ?? CODEX_TOKEN_FILES,
    codexInternalSources: opts.codexInternalSources ?? CODEX_INTERNAL_SOURCES, codexWrapperWaitMs: parseWrapperWait(opts.codexWrapperWaitMs),
  };
  const codexLauncher = resolveCodex(opts.codexBin ?? 'codex', baseEnv);
  const version = codexVersion(codexLauncher.path, baseEnv);
  return { ...fields, codexLauncher, codexVersion: version, codexVault: openAuthVault(opts.codexAuth ?? defaultAuthFile(baseEnv)) };
}

/** A login failure stops the run: a run that goes on without a login would fill cells with a broken tool (plan R6). */
function assertLoggedIn(ctx, run, t, cc) {
  const said = failureText(cc);
  if (!CODEX_AUTH_RE.test(said)) return;
  const text = redact(ctx.codexVault, run.dirs.codexHome, said.replace(/\s+/g, ' ').trim().slice(-300));
  throw new Error(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: Codex says its login failed (${text}); log in to Codex again, then start a new run`);
}

/** MCP or app tools in a run's Codex home are a setup fault that hits every arm, so the run stops (plan R28). */
function assertNoMcp(run, t, files) {
  const names = [...new Set(parseRollouts(files).mcp)];
  if (names.length) throw new Error(`${run.s.id} ${t.id} ${run.arm} seed${run.seed}: the Codex session called MCP or app tools (${names.join(', ')}); a run's Codex home must load none`);
}

/** One Codex session on the task prompt, inside the limit loop; the login copy is in the home only while it runs and waits. */
export async function runCodexSession(ctx, run, t, reset) {
  const { codexHome } = run.dirs;
  const vault = ctx.codexVault;
  let before = new Set(listRollouts(codexHome));
  let priorLog = '';
  const command = () => {
    // Taken per attempt, so a cut-off attempt's rollout stays on disk (prereg 113) but is never priced.
    before = new Set(listRollouts(codexHome));
    // A finished worker log from an earlier apply or attempt stays until this attempt's worker truncates it.
    priorLog = readIfPresent(wrapperLog(run))?.toString('utf8') ?? '';
    return `${quoteArg(run.codexLauncher)} ${codexArgs(ctx, run).map(quoteArg).join(' ')}`;
  };
  try {
    authIn(vault, codexHome);
    const session = await untilNotLimited(ctx, run, t, {
      command, input: t.prompt, rawName: 'limit', reset, env: codexEnv(run),
      isLimit: (cc) => CODEX_LIMIT_RE.test(failureText(cc)), redact: (text) => redact(vault, codexHome, text),
    });
    assertLoggedIn(ctx, run, t, session.cc);
    const wait = session.stopped ? { ms: 0, timedOut: false } : await memoryWait(ctx.codexMemoryWait, codexHome);
    const threadId = threadIdFrom(session.cc.stdout);
    const rollouts = sessionRollouts(codexHome, before, threadId, ctx.codexInternalSources);
    assertNoMcp(run, t, [...rollouts.agent, ...rollouts.internal, ...rollouts.stray]);
    const cc = { ...session.cc, stdout: redact(vault, codexHome, session.cc.stdout), stderr: redact(vault, codexHome, session.cc.stderr) };
    return { ...session, cc, threadId, rollouts, wait, priorLog, usage: rolloutUsage(rollouts.agent), internalUsage: rolloutUsage(rollouts.internal) };
  } finally {
    authOut(vault, codexHome);
    removeTokenFiles(codexHome, ctx.codexTokenFiles);
  }
}
