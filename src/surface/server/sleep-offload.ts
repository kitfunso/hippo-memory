// POST /v1/sleep and the MCP auto-sleep run their consolidation in a child process, so the server keeps answering and a
// stuck run can be stopped.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type Actor, type SleepOpts, type SleepResult, type Context } from '../../api/index.js';
import { logPhaseFailures } from '../../api/sleep/upkeep.js';
import type { ConsolidationResult } from '../../domain/consolidate/run.js';
import { StoreBusyError } from '../../store/port.js';
import { envSleepTimeoutMs } from '../../base/util/env.js';
import { HttpError, STORE_NOT_PORTED_MESSAGE } from '../../base/util/http-util.js';

const DEFAULT_SLEEP_DEADLINE_MS = 600_000;

/** What the child needs to rebuild the request's context (the store handle itself cannot cross a process boundary), or
 * the store an auto-sleep consolidates. */
export type SleepJob =
  | {
      readonly kind: 'sleep';
      readonly hippoRoot: string;
      readonly tenantId: string;
      readonly actor: Actor;
      readonly opts: SleepOpts;
    }
  | { readonly kind: 'consolidate'; readonly hippoRoot: string };

/** A job as the child receives it, with the epoch ms at which the server stops it, so work after the sleep stops
 * first. */
export type SleepMessage = SleepJob & { readonly deadline: number };

export type SleepReply<R = SleepResult> =
  | { readonly ok: true; readonly result: R }
  | { readonly ok: false; readonly busy: boolean; readonly message: string; readonly stack?: string };

// Resolved from the package root, so a server run from TypeScript source starts the same built file.
const CHILD_ENTRY = fileURLToPath(new URL('../../../dist/surface/server/sleep-child.js', import.meta.url));

/** The shape check for what crosses the IPC channel; the result's own fields are the API's to define. */
export function isSleepReply<R, M>(message: M): message is M & SleepReply<R> {
  if (typeof message !== 'object' || message === null || !('ok' in message)) return false;
  if (message.ok === true) return 'result' in message && typeof message.result === 'object' && message.result !== null;
  return (
    message.ok === false &&
    'busy' in message &&
    typeof message.busy === 'boolean' &&
    'message' in message &&
    typeof message.message === 'string'
  );
}

function failureOf<R>(reply: SleepReply<R> | undefined, code: number | null, signal: NodeJS.Signals | null): Error {
  if (!reply || reply.ok) return new Error(`sleep process ended without an answer (code ${code}, signal ${signal})`);
  // A lock the child could not get is the same retryable 503 an in-process sleep gave.
  if (reply.busy) return new StoreBusyError(reply.message);
  const failure = new Error(reply.message);
  if (reply.stack) failure.stack = reply.stack;
  return failure;
}

/** A child's answer, settled by its reply, and its end, which comes after the work it does once it has replied. */
interface ChildRun<R> {
  readonly answer: Promise<R>;
  readonly ended: Promise<void>;
}

function runInChild<R>(job: SleepJob): ChildRun<R> {
  let ended: () => void = () => undefined;
  const end = new Promise<void>((resolve) => {
    ended = resolve;
  });
  return { answer: childAnswer<R>(job, ended), ended: end };
}

function childAnswer<R>(job: SleepJob, ended: () => void): Promise<R> {
  const deadlineMs = envSleepTimeoutMs() ?? DEFAULT_SLEEP_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    // The child's stderr is the server's log, so Node's experimental-module notice would repeat there on every sleep.
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD_ENTRY], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    let reply: SleepReply<R> | undefined;
    let timedOut = false;
    let malformed = false;
    // SIGKILL because the child is inside synchronous hippo.db work and cannot run a handler; the OS drops its write
    // lock.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.once('message', (message) => {
      if (isSleepReply<R, typeof message>(message)) reply = message;
      else malformed = true;
      if (reply?.ok) resolve(reply.result);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      ended();
      reject(err);
    });
    // 'close' and not 'exit': it waits for the channel to drain, so the reply is in hand and the child's store handles
    // are gone.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      ended();
      if (reply?.ok) return;
      if (timedOut) {
        reject(
          new HttpError(
            504,
            `sleep did not finish within ${deadlineMs} ms and was stopped; the next sleep carries on from there`,
          ),
        );
      } else if (malformed) {
        reject(new Error(`sleep process sent a reply that is not a sleep result (code ${code}, signal ${signal})`));
      } else reject(failureOf(reply, code, signal));
    });
    child.send({ ...job, deadline: Date.now() + deadlineMs } satisfies SleepMessage);
  });
}

// One running and one waiting: each further sleep would only hold a request open behind work the waiting one already
// covers.
const MAX_SLEEPS_IN_LINE = 2;
const SLEEP_RETRY_AFTER_SEC = 30;

/** A server's sleeps, one at a time in a child process: POST /v1/sleep and the auto-sleep a write starts share it. */
export interface SleepQueue {
  /** `sleep` for the HTTP route: same result and errors, stopped at the deadline (10 minutes, or
   * HIPPO_SLEEP_TIMEOUT_MS). */
  readonly sleep: (ctx: Context, opts: SleepOpts) => Promise<SleepResult>;
  /** The auto-sleep's consolidation; auto-sleep only starts on a hippo.db store. */
  readonly consolidate: () => Promise<void>;
  /** Resolves once every sleep in line has ended, each by its deadline at the latest; it never rejects. */
  readonly settled: () => Promise<void>;
}

/** The queue of the server on `hippoRoot`, whose child reopens that folder; `onHippoDb` says the served store is it. */
export function createSleepQueue(hippoRoot: string, onHippoDb: boolean): SleepQueue {
  let turn: Promise<void> = Promise.resolve();
  let inLine = 0;
  const inTurn = <R>(job: SleepJob): Promise<R> => {
    if (inLine >= MAX_SLEEPS_IN_LINE) {
      return Promise.reject(
        new HttpError(
          503,
          'a sleep is already running and another is waiting; retry when one has finished',
          SLEEP_RETRY_AFTER_SEC,
        ),
      );
    }
    inLine += 1;
    // One sleep at a time, as on the server's single thread: a second one waits its turn and does not fight the first
    // for the write lock.
    const child = turn.then(() => runInChild<R>(job));
    // A failed sleep reaches its own caller through its answer; the turn lasts until the child has exited.
    turn = child
      .then((run) => run.ended)
      .finally(() => {
        inLine -= 1;
      });
    return child.then((run) => run.answer);
  };
  return {
    // The child sleeps the hippo.db under the folder, so another store that sets the sleep groups gets 501 as before.
    sleep: (ctx, opts) =>
      onHippoDb
        ? inTurn<SleepResult>({ kind: 'sleep', hippoRoot, tenantId: ctx.tenantId, actor: ctx.actor, opts })
        : Promise.reject(new HttpError(501, STORE_NOT_PORTED_MESSAGE)),
    consolidate: async () => {
      logPhaseFailures(await inTurn<ConsolidationResult>({ kind: 'consolidate', hippoRoot }));
    },
    settled: () => turn,
  };
}
