// The detached session-end workers a hook run starts outlive the hook, so a test records their pids and waits for them
// to end before it removes the folder they work in.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { pidAlive } from '../../src/host/pid-alive.js';
import { removeWhenStopped } from './make-root.js';
import { waitFor } from './wait-for.js';

// Forward slashes, since NODE_OPTIONS reads a backslash as an escape.
const RECORD_SPAWN = resolve(__dirname, 'record-spawn.cjs').split(sep).join('/');
const WORKER_VERBS = ['__session-end-worker', '__codex-session-end-worker'];
// A CLI run in this process (runCliAs) spawns its workers from here, so the recorder loads here too; it writes only
// while RECORD_SPAWN_FILE is set, which runCliAs does for the run's own env.
createRequire(import.meta.url)(RECORD_SPAWN);
/** How long a worker gets to end and a worker's log line gets to appear; the reason says why it is over 10 s. */
export const WORKER_GONE_MS = 25_000;

/** Step 0 measured a worker's sleep and capture at up to 6.5 s, over the 3.3 s a 10 s deadline allows. */
export const WORKER_REASON = 'a detached session-end worker; step 0 measured up to 6.5 s';

const recordFile = (dir: string): string => join(dir, 'spawns.jsonl');

interface SpawnRecord {
  readonly argv: readonly string[] | null;
  readonly pid: number | null;
}

/** `env` with the spawn recorder preloaded; the hook's workers inherit it, so their own spawns land in the same file. */
export function recordingPids(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  return {
    ...env,
    RECORD_SPAWN_FILE: recordFile(dir),
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --require "${RECORD_SPAWN}"`,
  };
}

/** The pids of every session-end worker recorded under `dir` so far. */
export function workerPids(dir: string): number[] {
  const file = recordFile(dir);
  if (!existsSync(file)) return [];
  const parse = (line: string): SpawnRecord => {
    // SAFETY: record-spawn.cjs writes one SpawnRecord per line.
    return JSON.parse(line) as SpawnRecord;
  };
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map(parse)
    .filter((r) => r.argv?.some((arg) => WORKER_VERBS.includes(arg)))
    .map((r) => {
      if (r.pid === null) throw new Error(`a worker spawn recorded no pid: ${JSON.stringify(r.argv)}`);
      return r.pid;
    });
}

/** Waits until each recorded worker has exited, then rejects unless exactly `expected` were recorded. */
async function pidsGone(dir: string, expected: number, what: string): Promise<void> {
  const pids = workerPids(dir);
  await waitFor(() => pids.every((pid) => !pidAlive(pid)), {
    what: `${what}: workers ${pids.join(', ')} exited`,
    timeoutMs: WORKER_GONE_MS,
    intervalMs: 50,
    reason: WORKER_REASON,
  });
  if (pids.length !== expected) {
    throw new Error(`${what}: expected ${expected} session-end worker(s), the spawn record holds ${pids.length}`);
  }
}

/** Waits for the workers recorded under `dir` to exit, then removes `dir`; the first failure is the one thrown. */
export async function removeAfterWorkers(dir: string, expected: number, what: string): Promise<void> {
  const failures: Error[] = [];
  await pidsGone(dir, expected, what).catch((err: Error) => failures.push(err));
  await removeWhenStopped(dir).catch((err: Error) => failures.push(err));
  if (failures.length > 0) throw failures[0];
}
