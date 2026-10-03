// Z0 Claude Code arms (docs/evals/2026-09-29-z0-built-in-memory-prereg.md, "Arms"): settings, environment, PATH and the hippo shims.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HIPPO_JS, STRIP_ENV, pathKey } from './exec.mjs';

export const ARMS = ['A0', 'A1', 'A2', 'A5'];
// Prereg "Seeds": A0's gate needs a large effect, so it runs two.
export const ARM_SEEDS = { A0: 2, A1: 3, A2: 3, A5: 3 };
export const HIPPO_ARMS = new Set(['A2', 'A5']);
export const CARRY_ARMS = new Set(['A1', 'A2', 'A5']);
export const TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

const CAPTURE_EVENTS = ['SessionEnd', 'PreCompact', 'PostCompact', 'PostToolUseFailure'];
const STRIP_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'AWS_', 'CODEX_', 'HIPPO_'];
const STRIP_EXACT = new Set(['CLAUDECODE', ...STRIP_ENV].map((k) => k.toUpperCase()));
const LAUNCHERS = ['hippo', 'hippo.cmd', 'hippo.ps1', 'hippo.exe', 'hippo.bat'];
const REQUIRED_TOOLS = ['node', 'npm', 'npx', 'git'];
const SHAM_COMMANDS = ['remember', 'capture', 'learn', 'outcome'];

/** The `--settings` file for an arm; `hippoSettings` is what hippo's installer writes for Claude Code. */
export function armSettings(arm, hippoSettings) {
  if (arm === 'A0') return { autoMemoryEnabled: false };
  if (arm === 'A1') return {};
  if (arm === 'A2') return hippoSettings;
  if (arm === 'A5') {
    const hooks = Object.fromEntries(Object.entries(hippoSettings.hooks ?? {}).filter(([event]) => !CAPTURE_EVENTS.includes(event)));
    return { ...hippoSettings, hooks };
  }
  throw new Error(`unknown arm ${arm}; known: ${ARMS.join(', ')}`);
}

function stripped(key) {
  const k = key.toUpperCase();
  return STRIP_EXACT.has(k) || STRIP_PREFIXES.some((p) => k.startsWith(p));
}

function getKey(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** A session's environment: the parent's minus every provider, Claude, Codex and hippo key, plus the run's own homes and PATH. */
export function armEnv(arm, dirs, baseEnv, { passEnv = [] } = {}) {
  if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}; known: ${ARMS.join(', ')}`);
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([k]) => !stripped(k)));
  const token = getKey(baseEnv, TOKEN_KEY);
  if (token !== undefined) env[TOKEN_KEY] = token;
  env.CLAUDE_CONFIG_DIR = dirs.claudeConfig;
  env.CODEX_HOME = dirs.codexHome;
  env.HIPPO_HOME = dirs.hippoHome;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = arm === 'A0' ? '1' : '0';
  env.HIPPO_AGENT_MEMORY_TOOLS = 'claude-code,codex';
  env.DISABLE_AUTOUPDATER = '1';
  env.EVAL_SEED = String(dirs.seed);
  for (const name of passEnv) {
    const value = getKey(baseEnv, name);
    if (value !== undefined) env[name] = value;
  }
  const key = pathKey(baseEnv);
  const cleaned = cleanPath(baseEnv[key] ?? '', { env: baseEnv }).value;
  env[key] = HIPPO_ARMS.has(arm) ? `${dirs.bin}${path.delimiter}${cleaned}` : cleaned;
  return env;
}

/** The env for setup, tests, init and the homes check: no OAuth token, and (unless keepBin) no run `bin/` on PATH. */
export function childEnv(env, { keepBin = false } = {}) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== TOKEN_KEY));
  if (!keepBin && out.CLAUDE_CONFIG_DIR) {
    // The run's bin/ is its config dir's sibling, so it is found without a second argument.
    const bin = path.join(path.dirname(out.CLAUDE_CONFIG_DIR), 'bin');
    const key = pathKey(out);
    out[key] = (out[key] ?? '').split(path.delimiter).filter((e) => e !== bin).join(path.delimiter);
  }
  return out;
}

/** A `hippo` on PATH that runs this checkout; `sham` turns the capture commands into silent no-ops (A5). */
export function writeHippoShim(binDir, fakeHome, mode) {
  if (mode !== 'real' && mode !== 'sham') throw new Error(`unknown shim mode ${mode}`);
  // A fake HOME keeps hippo off the operator's ~/.claude (MEMORY.md import, capture scans, hook installs).
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  // Only the prereg's capture commands are sham; note, customer-note, sleep and import stay real.
  const shCase = mode === 'sham' ? `case "$1" in ${SHAM_COMMANDS.join('|')}) exit 0;; esac\n` : '';
  const cmdIfs = mode === 'sham' ? SHAM_COMMANDS.map((c) => `@if /i "%~1"=="${c}" exit /b 0\r\n`).join('') : '';
  fs.writeFileSync(path.join(binDir, 'hippo'), `#!/bin/sh\n${shCase}export HOME="${fakeHome}" USERPROFILE="${fakeHome}"\nexec "${process.execPath}" "${HIPPO_JS}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'hippo.cmd'), `${cmdIfs}@set "HOME=${fakeHome}"\r\n@set "USERPROFILE=${fakeHome}"\r\n@"${process.execPath}" "${HIPPO_JS}" %*\r\n`);
}

function normaliseEntry(entry, env, cwd, platform) {
  let e = entry.trim();
  if (e.length >= 2 && e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1).trim();
  if (e === '') return null;
  if (platform === 'win32') e = e.replace(/%([^%]+)%/g, (m, name) => getKey(env, name) ?? m);
  return path.resolve(cwd, e);
}

const holdsLauncher = (dir) => LAUNCHERS.some((name) => fs.existsSync(path.join(dir, name)));

/** PATH without any dir holding a hippo launcher, so A0 and A1 get the shell's own "not found" and A2/A5 only their shim. */
export function cleanPath(pathValue, { env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  const kept = [];
  const removed = [];
  for (const entry of String(pathValue ?? '').split(path.delimiter)) {
    const dir = normaliseEntry(entry, env, cwd, platform);
    if (dir === null) continue;
    if (holdsLauncher(dir)) {
      if (!removed.includes(dir)) removed.push(dir);
      continue;
    }
    kept.push(path.isAbsolute(entry.trim().replace(/^"|"$/g, '')) ? entry : dir);
  }
  return { value: kept.join(path.delimiter), removed };
}

/** The first file `name` resolves to on a PATH value (PATHEXT-aware on win32), or null. */
export function which(name, pathValue, { env = process.env, platform = process.platform } = {}) {
  const exts = platform === 'win32' ? ['', ...(getKey(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const entry of String(pathValue ?? '').split(path.delimiter)) {
    const dir = normaliseEntry(entry, env, process.cwd(), platform);
    if (dir === null) continue;
    for (const ext of exts) {
      const file = path.join(dir, `${name}${ext}`);
      if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    }
  }
  return null;
}

const firstToken = (cmd) => (cmd.trim().startsWith('"') ? cmd.trim().slice(1).split('"')[0] : cmd.trim().split(/\s+/)[0]);
const isBareName = (cmd) => /^[\w.-]+$/.test(cmd);
const sameDir = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** A bare `claude` name resolved once to an absolute, quoted path on the uncleaned PATH; a command string is left as is. */
export function resolveClaude(claudeBin, pathValue, opts = {}) {
  if (!isBareName(claudeBin)) return claudeBin;
  const found = which(claudeBin, pathValue, opts);
  if (!found) throw new Error(`${claudeBin} is not on PATH; install Claude Code or pass --claude-bin`);
  return `"${found}"`;
}

/** Refuse to run when hiding the hippo launcher dirs also hid a tool the runner or the agent needs. */
export function assertToolsResolve(cleanedPath, claudeCmd, removed = [], opts = {}) {
  const missing = REQUIRED_TOOLS.filter((t) => !which(t, cleanedPath, opts));
  const claude = firstToken(claudeCmd);
  if (path.isAbsolute(claude)) {
    if (!fs.existsSync(claude) || removed.some((d) => sameDir(path.dirname(claude), d))) missing.push(`claude (${claude})`);
  } else if (!which(claude, cleanedPath, opts)) missing.push(claude);
  if (missing.length === 0) return;
  const dirs = removed.length > 0 ? removed.join(', ') : 'none';
  throw new Error(`with the hippo launcher dirs (${dirs}) off PATH, these no longer resolve: ${missing.join(', ')}. Install hippo in its own prefix, or uninstall the global copy, so those dirs hold no hippo.`);
}

/** Resolve claude and check the cleaned PATH once, before any run: returns the claude command every session spawns. */
export function startupTools(claudeBin, baseEnv) {
  const pathValue = baseEnv[pathKey(baseEnv)] ?? '';
  const { value, removed } = cleanPath(pathValue, { env: baseEnv });
  const claude = resolveClaude(claudeBin, pathValue, { env: baseEnv });
  assertToolsResolve(value, claude, removed, { env: baseEnv });
  return { claude, removed };
}
