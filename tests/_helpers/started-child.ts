// The one way a test runs an async child: each wait is on a printed line or the exit, with its own deadline, and the
// whole process tree is gone before the test's folder is removed.
import { spawn } from 'node:child_process';
import { killTree } from '../../src/host/kill-tree.js';
import { trackLive } from './make-root.js';
import { EVENT_DEADLINE_MS, checkDeadline } from './wait-for.js';

export interface StartOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed; without it stdin stays open for send(). */
  readonly input?: string;
  /** Default for each line() and exited() call, which each start their own deadline. */
  readonly deadlineMs?: number;
  /** Required when a deadline is over EVENT_DEADLINE_MS. */
  readonly reason?: string;
  /** 'test' children stop when the test ends; 'file' children when the file does. */
  readonly lifetime?: 'test' | 'file';
}

export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StartedChild {
  readonly pid: number;
  output(): { stdout: string; stderr: string };
  /** Resolves on the first stdout line after the last matched one that matches `pattern`. */
  line(pattern: RegExp, what: string, deadlineMs?: number): Promise<RegExpExecArray>;
  send(text: string | Uint8Array): void;
  /** Closes stdin; resolves once what was sent is flushed. */
  endInput(): Promise<void>;
  /** Closes this side of stdout, so the child's next write fails as it would after its reader quit. */
  closeOutput(): void;
  running(): boolean;
  /** Kills the child's tree (SIGTERM first when graceful) and resolves once the child has exited. */
  stop(opts?: { graceful?: boolean }): Promise<void>;
  /** `reason` is required with a deadline over EVENT_DEADLINE_MS that the start options did not give one for. */
  exited(deadlineMs?: number, reason?: string): Promise<ChildExit>;
}

const STOP_EXIT_MS = 2_000;

/** A whole run of a process that opens a store: CI's slowest such test took 6.2 s, so the bound is 4 times that. */
export const STORE_RUN_MS = 25_000;
export const STORE_RUN_REASON = 'a whole process run that opens a store; the 10 s default is for one event';

/** POSIX: kills what is left of the child's process group; a group id is never reused while a member lives. */
function killGroup(pid: number): void {
  if (process.platform === 'win32') return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    // SAFETY: process.kill throws a NodeJS.ErrnoException.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}
const TAIL_CHARS = 2_048;

/** Runs `node <args>` with piped stdio and tracks it, so it is stopped before the test's folder is removed. */
export function startNode(args: readonly string[], opts: StartOptions = {}): StartedChild {
  return startCommand(process.execPath, args, opts);
}

/** startNode for a program other than node, such as a shell that holds a Windows file lock. */
export function startCommand(command: string, args: readonly string[], opts: StartOptions = {}): StartedChild {
  const defaultMs = checkDeadline(opts.deadlineMs ?? EVENT_DEADLINE_MS, 'startNode', opts.reason);
  // POSIX: its own process group, so stop() reaches a grandchild whose parent already exited.
  const child = spawn(command, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: 'pipe',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  // Listened for before anything else: a spawn that fails (a missing cwd) emits 'error' with no pid.
  let spawnError: Error | null = null;
  child.on('error', (err) => {
    spawnError = err;
    wake();
  });
  const pid = child.pid ?? -1;
  const out = { stdout: '', stderr: '' };
  const lines: string[] = [];
  let partial = '';
  let all = '';
  let consumed = 0;
  let exit: ChildExit | null = null;
  const waiters = new Set<() => boolean>();
  const wake = (): void => {
    for (const check of waiters) if (check()) waiters.delete(check);
  };
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk: string) => {
      out[stream] += chunk;
      all += chunk;
      if (stream === 'stdout') {
        const parts = (partial + chunk).split(/\r?\n/);
        partial = parts.pop() ?? '';
        lines.push(...parts);
      }
      wake();
    });
  }
  child.on('close', (code, signal) => {
    if (partial !== '') lines.push(partial);
    exit = { code, signal, ...out };
    wake();
  });
  // A child that exits before reading stdin makes a write fail with EPIPE; it is named in any failure, as its exit is.
  let stdinError = '';
  child.stdin.on('error', (err) => {
    stdinError = `; stdin: ${err.message}`;
  });
  if (opts.input !== undefined) child.stdin.end(opts.input);

  const state = (): string => {
    const how = exit === null ? 'still running' : `exited with ${exit.code ?? exit.signal}`;
    return `child ${pid} ${how}${stdinError}; last output:\n${all.slice(-TAIL_CHARS)}`;
  };

  function awaitEvent<T>(what: string, ms: number, settle: () => T | undefined, early: () => boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`${what} not seen within ${ms} ms: ${state()}`));
      }, ms);
      const check = (): boolean => {
        const value = settle();
        if (spawnError !== null) reject(spawnError);
        else if (value !== undefined) resolve(value);
        else if (early()) reject(new Error(`${what} not seen: ${state()}`));
        else return false;
        clearTimeout(timer);
        return true;
      };
      if (!check()) waiters.add(check);
    });
  }

  let stopping: Promise<void> | null = null;
  const handle: StartedChild = {
    pid,
    output: () => ({ ...out }),
    line(pattern, what, deadlineMs) {
      const ms = checkDeadline(deadlineMs ?? defaultMs, `line(${what})`, opts.reason);
      // Each wait scans on its own from the last matched line, so a wait for a later line never skips an earlier one.
      let at = consumed;
      const settle = (): RegExpExecArray | undefined => {
        for (; at < lines.length; at++) {
          const found = pattern.exec(lines[at]);
          if (found !== null) {
            consumed = Math.max(consumed, at + 1);
            return found;
          }
        }
        return undefined;
      };
      return awaitEvent(what, ms, settle, () => exit !== null);
    },
    send(text) {
      child.stdin.write(text);
    },
    endInput: () => new Promise((resolve) => child.stdin.end(resolve)),
    closeOutput() {
      child.stdout.destroy();
    },
    running: () => spawnError === null && exit === null && child.exitCode === null && child.signalCode === null,
    exited(deadlineMs, reason) {
      const ms = checkDeadline(deadlineMs ?? defaultMs, `exited(${pid})`, reason ?? opts.reason);
      return awaitEvent(
        `exit of child ${pid}`,
        ms,
        () => exit ?? undefined,
        () => false,
      );
    },
    stop({ graceful = false } = {}) {
      stopping ??= (async () => {
        if (spawnError !== null) return;
        // Windows has no SIGTERM to handle (a kill is TerminateProcess), so a graceful stop there is the tree kill.
        if (graceful && process.platform !== 'win32' && exit === null) {
          child.kill('SIGTERM');
          await handle.exited(STOP_EXIT_MS).catch(() => undefined);
        }
        // Only while the child lives: after its exit the pid may already belong to another process.
        if (exit === null) await killTree(pid);
        killGroup(pid);
        await handle.exited(STOP_EXIT_MS).catch(() => {
          throw new Error(`child ${pid} still running ${STOP_EXIT_MS} ms after it was killed`);
        });
      })();
      return stopping;
    },
  };
  trackLive({ lifetime: opts.lifetime ?? 'test', stop: () => handle.stop() });
  return handle;
}
