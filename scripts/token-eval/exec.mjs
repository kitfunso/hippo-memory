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

/** Prepend a dir to PATH under the key the env already uses, never a second one. */
export function prependPath(env, dir) {
  const key = pathKey(env);
  env[key] = `${dir}${path.delimiter}${env[key] ?? ''}`;
  return env;
}

export function sh(cmd, cwd, env, timeoutMs = 30 * 60_000, input = undefined) {
  const r = spawnSync(cmd, { cwd, env, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 28, input });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function git(args, cwd, env = undefined) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
}
