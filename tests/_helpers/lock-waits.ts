// How long a spawned CLI asked to wait for the store lock, read from the child itself: a stopwatch around the child also times the runner.
import * as fs from 'node:fs';
import * as path from 'node:path';

// Forward slashes, since NODE_OPTIONS reads a backslash as an escape.
const PRELOAD = path.resolve(__dirname, 'lock-wait-trace.cjs').split(path.sep).join('/');

interface LockWaitTrace {
  busy: { sql: string; waitMs: number }[];
  sleeps: number[];
}

/** `env` plus the preload that makes each CLI spawned with it record its lock waits under `dir`. */
export function tracingLockWaits(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  fs.mkdirSync(dir, { recursive: true });
  return { ...env, LOCK_WAIT_TRACE_DIR: dir, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --require "${PRELOAD}"` };
}

/** Milliseconds process `pid` asked to wait on a held lock: the busy timeout of each statement that met it, plus each retry-loop pause. */
export function lockWaitAskedMs(dir: string, pid: number): number {
  // SAFETY: lock-wait-trace.cjs writes exactly this shape on exit.
  const trace = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8')) as LockWaitTrace;
  return trace.busy.reduce((sum, statement) => sum + statement.waitMs, 0) + trace.sleeps.reduce((sum, ms) => sum + ms, 0);
}
