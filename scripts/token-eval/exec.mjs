// Process helpers shared by the token-eval runner modules. A leaf: it imports nothing local, so any module can take it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const HIPPO_JS = path.join(REPO, 'bin', 'hippo.js');

/** The key the env already uses for PATH (Windows spells it Path). */
export function pathKey(env) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

export function sh(cmd, cwd, env, timeoutMs = 30 * 60_000, input = undefined) {
  const r = spawnSync(cmd, { cwd, env, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 28, input });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: r.error?.code === 'ETIMEDOUT' };
}

const MAX_OUTPUT = 1 << 28;
const STOP_TREE = path.join(HERE, 'stop-tree.ps1');

/** Kill `pid` and everything under it; a kill that fails is said in the returned text, never thrown. */
async function killTree(child) {
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return '';
    } catch (err) {
      child.kill('SIGKILL');
      return `\n[kill -${child.pid}: ${err.code ?? err.message}]`;
    }
  }
  // Node holds the child's handle until it sees the exit, so a seen exit may have freed the pid, and a root that started after startedBy holds a freed pid.
  if (child.exitCode !== null || child.signalCode !== null) return '';
  const startedBy = new Date().toISOString();
  const said = await new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', STOP_TREE, '-RootPid', String(child.pid), '-StartedBy', startedBy];
    execFile('powershell', args, { windowsHide: true, timeout: 120_000 }, (err, out, stderr) => {
      const lines = String(out).split(/\r?\n/).filter((l) => l && l !== 'end');
      const why = lines.filter((l) => /^(failed|error) /.test(l)).join('; ') || lines.at(-1) || String(stderr).trim() || err?.message;
      resolve(err ? `\n[stop-tree: ${why}]` : '');
    });
  });
  if (said) child.kill('SIGKILL');
  return said;
}

/** sh() without blocking the event loop; a timeout kills the whole process tree, since spawnSync kills only the shell. */
export async function spawnTree(cmd, cwd, env, timeoutMs, input = undefined) {
  // POSIX: its own process group, so one kill reaches every descendant.
  const child = spawn(cmd, { cwd, env, shell: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  let timedOut = false;
  let killing = null;
  const stop = () => (killing ??= killTree(child).then((said) => { out.stderr += said; }));
  for (const key of ['stdout', 'stderr']) {
    child[key].setEncoding('utf8');
    child[key].on('data', (chunk) => {
      out[key] += chunk;
      if (out[key].length > MAX_OUTPUT) {
        out.stderr += `\n[${key} over ${MAX_OUTPUT} chars; killed]`;
        stop();
      }
    });
  }
  // A child that exits without reading its stdin breaks the pipe; the result says what the child did, so the write error is only noted.
  child.stdin.on('error', (err) => { out.stderr += `\n[stdin: ${err.code ?? err.message}]`; });
  child.stdin.end(input);
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const status = await new Promise((resolve) => {
    child.on('error', (err) => {
      out.stderr += `\n[spawn: ${err.message}]`;
      resolve(null);
    });
    child.on('exit', (code) => resolve(code));
  });
  clearTimeout(timer);
  if (killing) await killing;
  // A descendant that outlived the kill can hold the pipes open, so 'close' gets 2 s and then the pipes are cut.
  const closed = new Promise((resolve) => child.on('close', resolve));
  const grace = new Promise((resolve) => setTimeout(resolve, 2000).unref());
  if (child.stdout.readable || child.stderr.readable) await Promise.race([closed, grace]);
  child.stdout.destroy();
  child.stderr.destroy();
  return { status: status ?? 1, stdout: out.stdout, stderr: out.stderr, timedOut };
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

// Windows real-time scanning can hold a file git just wrote (anything in .git, a lock file, a temp index) past Git for Windows' own short rename retry.
// A work-tree file, a lock another git holds (File exists), commit's index failure after HEAD moved (a line break inside the phrase) and an update-ref old-value mismatch never match.
const SCAN_LOCK = /\.git[\\/][^\n]*: Permission denied|\.lock': Permission denied|[Uu]nable to write new index file|update_ref failed for ref '[^'\n]*': couldn't set/;
const LOCK_WAITS_MS = [500, 1000, 2000, 4000];
/** Retries taken this process, printed at the end of a run so an environment flake is seen, never hidden. */
export const objectLockRetries = { count: 0 };

/** fn(), rerun while git fails on a scan lock; git writes those files through a lock or temp file it drops on failure, so a rerun starts from the same state. */
export function retryObjectLock(fn, waits = LOCK_WAITS_MS) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= waits.length || !SCAN_LOCK.test(String(err.stderr ?? ''))) throw err;
      objectLockRetries.count++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waits[i]);
    }
  }
}

/** git() without the retry, for a caller that must clear a failed try's leftovers before the next. */
function gitOnce(args, cwd, extraEnv = {}, encoding = 'utf8') {
  const [argv, env] = runnerGit(args, extraEnv);
  return execFileSync('git', argv, { cwd, env, encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
}

/** Every runner git call goes through here, cloneFresh or gitSpawn; extraEnv adds keys but can never undo the isolation. */
export function git(args, cwd, extraEnv = {}, encoding = 'utf8') {
  return retryObjectLock(() => gitOnce(args, cwd, extraEnv, encoding));
}

/** Clone `repo` into `dest`, a dir no one else writes; `once` runs one git and is there for tests. */
export function cloneFresh(repo, dest, once = gitOnce) {
  // A clone a scan lock broke can leave a partial dir the next clone refuses, so each try starts with none.
  return retryObjectLock(() => {
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
    return once(['clone', '--quiet', repo, dest]);
  });
}

/** git() for a caller that reads the exit code itself; stdout and stderr are Buffers. */
export function gitSpawn(args, cwd) {
  const [argv, env] = runnerGit(args, {});
  return spawnSync('git', argv, { cwd, env, maxBuffer: 1 << 28 });
}
