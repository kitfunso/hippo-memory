// POST /v1/sleep and the MCP auto-sleep run their consolidation in a child process, so the server keeps answering and a
// stuck run can be stopped.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type Actor, type SleepOpts, type SleepResult, type ContextWith } from '../api/index.js';
import type { ConsolidationResult } from '../consolidate/run.js';
import { StoreBusyError } from '../store/port.js';
import { envSleepTimeoutMs } from '../util/env.js';
import { HttpError } from '../util/http-util.js';

const DEFAULT_SLEEP_DEADLINE_MS = 600_000;

/** What the child needs to rebuild the request's context (the store handle itself cannot cross a process boundary),
 * or the store an auto-sleep consolidates. */
export type SleepJob =
  | {
      readonly kind: 'sleep';
      readonly hippoRoot: string;
      readonly tenantId: string;
      readonly actor: Actor;
      readonly opts: SleepOpts;
    }
  | { readonly kind: 'consolidate'; readonly hippoRoot: string };

export type SleepReply<R = SleepResult> =
  | { readonly ok: true; readonly result: R }
  | { readonly ok: false; readonly busy: boolean; readonly message: string; readonly stack?: string };

// Resolved from the package root, so a server run from TypeScript source starts the same built file.
const CHILD_ENTRY = fileURLToPath(new URL('../../dist/server/sleep-child.js', import.meta.url));

function failureOf<R>(reply: SleepReply<R> | undefined, code: number | null, signal: NodeJS.Signals | null): Error {
  if (!reply || reply.ok) return new Error(`sleep process ended without an answer (code ${code}, signal ${signal})`);
  // A lock the child could not get is the same retryable 503 an in-process sleep gave.
  if (reply.busy) return new StoreBusyError(reply.message);
  const failure = new Error(reply.message);
  if (reply.stack) failure.stack = reply.stack;
  return failure;
}

function runInChild<R>(job: SleepJob): Promise<R> {
  const deadlineMs = envSleepTimeoutMs() ?? DEFAULT_SLEEP_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    // The child's stderr is the server's log, so Node's SQLite notice would repeat there on every sleep.
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD_ENTRY], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    let reply: SleepReply<R> | undefined;
    let timedOut = false;
    // SIGKILL because the child is inside synchronous SQLite work
    // and cannot run a handler; the OS drops its write lock.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, deadlineMs);
    child.once('message', (message) => {
      // SAFETY: sleep-child.ts is the only writer on this channel and sends exactly one SleepReply for the job it was
      // given.
      reply = message as SleepReply<R>;
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // 'close' and not 'exit': it waits for the channel to drain, so
    // the reply is in hand and the child's store handles are gone.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new HttpError(
            504,
            `sleep did not finish within ${deadlineMs} ms and was stopped; the next sleep carries on from there`,
          ),
        );
      } else if (reply?.ok) resolve(reply.result);
      else reject(failureOf(reply, code, signal));
    });
    child.send(job);
  });
}

let turn: Promise<void> = Promise.resolve();

// One running and one waiting: each further sleep would only hold
// a request open behind work the waiting one already covers.
const MAX_SLEEPS_IN_LINE = 2;
const SLEEP_RETRY_AFTER_SEC = 30;
let inLine = 0;

function inTurn<R>(job: SleepJob): Promise<R> {
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
  // One sleep at a time, as on the server's single thread: a second one waits its turn and does not fight the first for
  // the write lock.
  const run = turn.then(() => runInChild<R>(job));
  // A failed sleep reaches its own caller through `run`; the queue only needs to know the turn is over.
  turn = run
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      inLine -= 1;
    });
  return run;
}

/** `sleep` for the HTTP route: same result and errors, run outside the serving process and stopped at the deadline
 * (10 minutes, or HIPPO_SLEEP_TIMEOUT_MS). */
export function sleepInChild(ctx: ContextWith<'localFiles'>, opts: SleepOpts): Promise<SleepResult> {
  return inTurn<SleepResult>({
    kind: 'sleep',
    // The child reopens the folder the served store owns.
    hippoRoot: ctx.store.localFiles.hippoRoot,
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    opts,
  });
}

/** The MCP auto-sleep's consolidation, in the same queue and child
 * as POST /v1/sleep; auto-sleep only starts on a hippo.db store. */
export async function consolidateInChild(hippoRoot: string): Promise<void> {
  await inTurn<ConsolidationResult>({ kind: 'consolidate', hippoRoot });
}
