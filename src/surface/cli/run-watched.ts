// Runs a transfer command with its stderr streamed live and bounded, under a deadline.
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { killTree } from '../../host/kill-tree.js';
import { spawnArgv } from '../../host/spawn-argv.js';

/** The most stderr `runWatched` returns; the terminal still gets all of it. */
const STDERR_TAIL_BYTES = 64 * 1024;

/** A transfer command that has not exited in this long is hung on a prompt or a dead remote. */
export const RUN_WATCHED_DEADLINE_MS = 30 * 60_000;

/** The command passed its deadline and was killed. */
export class RunWatchedTimeoutError extends Error {
  constructor(
    readonly deadlineMs: number,
    readonly stderr: string,
  ) {
    super(`the command did not exit within ${deadlineMs} ms and was killed`);
    this.name = 'RunWatchedTimeoutError';
  }
}

/** Runs argv with no shell, so `;`, `&` and `$()` reach it literally; stderr streams live and
 * only its last 64 KiB comes back. Rejects with RunWatchedTimeoutError past `deadlineMs`. */
export function runWatched(
  argv: readonly string[],
  deadlineMs: number = RUN_WATCHED_DEADLINE_MS,
): Promise<{ exitCode: number; stderr: string }> {
  return watchChild(spawnArgv(argv, WATCHED_SPAWN_OPTIONS), deadlineMs);
}

const WATCHED_SPAWN_OPTIONS: SpawnOptions = {
  stdio: ['inherit', 'inherit', 'pipe'],
  windowsHide: true,
};

function watchChild(
  child: ChildProcess,
  deadlineMs: number,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    let tail = Buffer.alloc(0);

    child.stderr?.on('data', (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES);
      process.stderr.write(chunk);
    });

    // Rejects first so the caller sees the timeout at once; the tree kill is not awaited.
    const timer = setTimeout(() => {
      reject(new RunWatchedTimeoutError(deadlineMs, tail.toString('utf8')));
      if (child.pid === undefined) return;
      void killTree(child.pid).catch((err) =>
        log.warn(`run-watched: process tree not killed: ${errorMessage(err)}`, errorFields(err)),
      );
    }, deadlineMs);

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stderr: tail.toString('utf8') });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stderr: err.message });
    });
  });
}
