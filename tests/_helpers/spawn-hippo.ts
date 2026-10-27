// One place that spawns bin/hippo.js for tests, so a test file states its cwd, env and input and nothing else.
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { HIPPO_BIN } from './hippo-bin.js';
import { STORE_RUN_MS, STORE_RUN_REASON, startNode } from './started-child.js';
import { HANG_GUARD_MS, checkDeadline } from './wait-for.js';

export interface HippoSpawnOptions {
  readonly cwd?: string;
  /** The full child env: the caller composes it, so a test that must drop PATH or HOME keys can. */
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  /** A sync child blocks the test thread, so vitest's own timer cannot end it; this guard does, at HANG_GUARD_MS by default. */
  readonly timeout?: number;
  /** Required with a timeout over EVENT_DEADLINE_MS: why this run needs longer than an event. */
  readonly reason?: string;
  /** Node binary to run; a test that wants the PATH one passes 'node'. */
  readonly exe?: string;
}

// The default is the hang guard, not an event wait: it only ends a CLI run that never finishes.
const DEFAULT_GUARD_REASON = 'the hang guard on a whole CLI run, which a caller does not set';

function spawnArgs(args: readonly string[], opts: HippoSpawnOptions) {
  const { cwd, env, input, timeout = HANG_GUARD_MS } = opts;
  checkDeadline(timeout, `hippo ${args.join(' ')}`, opts.timeout === undefined ? DEFAULT_GUARD_REASON : opts.reason);
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
export async function hippoRunAsync(
  args: readonly string[],
  opts: HippoSpawnOptions = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const { cwd, env, input = '', timeout = STORE_RUN_MS } = opts;
  if (opts.exe !== undefined) throw new Error('hippoRunAsync runs process.execPath; exe is for the sync runners');
  const reason = opts.timeout === undefined ? STORE_RUN_REASON : opts.reason;
  const child = startNode([HIPPO_BIN, ...args], { cwd, env, input, deadlineMs: timeout, reason });
  const { code, stdout, stderr } = await child.exited();
  return { status: code, stdout, stderr };
}
