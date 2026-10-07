// Process helpers shared by the token-eval runner modules. A leaf: it imports nothing local, so any module can take it.
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const HIPPO_JS = path.join(REPO, 'bin', 'hippo.js');

// A parent session id makes a child Claude Code session report and log under the parent's id.
export const STRIP_ENV = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'HIPPO_SESSION_ID', 'HIPPO_HOME', 'HIPPO_TENANT'];

/** The key the env already uses for PATH (Windows spells it Path). */
export function pathKey(env) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

export function sh(cmd, cwd, env, timeoutMs = 30 * 60_000, input = undefined) {
  const r = spawnSync(cmd, { cwd, env, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 28, input });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' };
}

// Git for Windows opens /dev/null as the null device but joins hook names onto it as <drive>:\dev\null, which any user can create; Win32 refuses '|' in a name.
const NO_HOOKS = process.platform === 'win32' ? '/|no-hooks|' : '/dev/null';

/** Args and env for a git that reads no system or global config, no global attributes and runs no hooks or fsmonitor. */
function runnerGit(args, extraEnv) {
  // The agent shares the operator's HOME, so anything git reads from there (config, ~/.config/git/attributes) is agent-writable.
  // Git for Windows reads /dev/null as the null device; os.devNull (\\.\nul) it refuses.
  const env = { ...process.env, ...extraEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  // The cache repo's local config is still read, and core.fsmonitor there names a program git runs on checkout and update-index.
  return [['-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.attributesFile=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', ...args], env];
}

/** Every runner git call goes through here or gitSpawn; extraEnv adds keys but can never undo the isolation. */
export function git(args, cwd, extraEnv = {}, encoding = 'utf8') {
  const [argv, env] = runnerGit(args, extraEnv);
  return execFileSync('git', argv, { cwd, env, encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
}

/** git() for a caller that reads the exit code itself; stdout and stderr are Buffers. */
export function gitSpawn(args, cwd) {
  const [argv, env] = runnerGit(args, {});
  return spawnSync('git', argv, { cwd, env, maxBuffer: 1 << 28 });
}
