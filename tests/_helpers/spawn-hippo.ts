// One place that spawns bin/hippo.js for tests, so a test file states its cwd, env and input and nothing else.
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { resolve } from 'node:path';

export const HIPPO_BIN = resolve(__dirname, '..', '..', 'bin', 'hippo.js');

export interface HippoSpawnOptions {
  readonly cwd?: string;
  /** The full child env: the caller composes it, so a test that must drop PATH or HOME keys can. */
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeout?: number;
  /** Node binary to run; a test that wants the PATH one passes 'node'. */
  readonly exe?: string;
}

function spawnArgs(args: readonly string[], opts: HippoSpawnOptions) {
  const { cwd, env, input, timeout } = opts;
  return [opts.exe ?? process.execPath, [HIPPO_BIN, ...args], { cwd, env, input, timeout, encoding: 'utf8' }] as const;
}

/** Returns stdout; a non-zero exit throws the execFileSync error (stdout, stderr and status on it). */
export function hippoOut(args: readonly string[], opts: HippoSpawnOptions = {}): string {
  const [exe, argv, options] = spawnArgs(args, opts);
  return execFileSync(exe, argv, options);
}

/** Never throws on a non-zero exit; the caller reads status, stdout and stderr. */
export function hippoRun(args: readonly string[], opts: HippoSpawnOptions = {}): SpawnSyncReturns<string> {
  const [exe, argv, options] = spawnArgs(args, opts);
  return spawnSync(exe, argv, options);
}

/** `hippoRun` that leaves the caller's thread free, for a child that calls a server the test runs. */
export function hippoRunAsync(args: readonly string[], opts: HippoSpawnOptions = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { cwd, env, timeout } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(opts.exe ?? process.execPath, [HIPPO_BIN, ...args], { cwd, env, timeout });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(opts.input ?? '');
  });
}
