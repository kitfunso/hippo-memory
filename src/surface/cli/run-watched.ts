// Runs a transfer command with its stderr streamed live and bounded, under a deadline.
import type { ChildProcess, SpawnOptions } from 'child_process';
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

/** Runs argv with no shell, so `;`, `&` and `$()` reach it literally; stderr streams live and only its last 64 KiB
 * comes back. Rejects with RunWatchedTimeoutError past `deadlineMs`. */
export function runWatched(
  argv: readonly string[],
  deadlineMs: number = RUN_WATCHED_DEADLINE_MS,
): Promise<{ exitCode: number; stderr: string }> {
  return watchChild(spawnArgv(argv, WATCHED_SPAWN_OPTIONS), deadlineMs);
}

const WATCHED_SPAWN_OPTIONS: SpawnOptions = { stdio: ['inherit', 'inherit', 'pipe'], windowsHide: true };

function watchChild(child: ChildProcess, deadlineMs: number): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    let tail = Buffer.alloc(0);

    child.stderr?.on('data', (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES);
      process.stderr.write(chunk);
    });

    // SHORTCUT: kills the direct child only (the shell or cmd.exe when there is one), so on Windows a grandchild can
    // outlive it; a process-tree kill is the upgrade path.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new RunWatchedTimeoutError(deadlineMs, tail.toString('utf8')));
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
