// POST /v1/sleep runs its consolidation in a child process, so the server keeps answering and a stuck run can be stopped.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sleep, type Actor, type Context, type SleepOpts, type SleepResult } from '../api.js';
import { StoreBusyError } from '../db.js';
import { envSleepTimeoutMs } from '../env.js';
import { HttpError } from '../http-util.js';

const DEFAULT_SLEEP_DEADLINE_MS = 600_000;

/** What the child needs to rebuild the request's context; the store handle itself cannot cross a process boundary. */
export interface SleepJob {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly actor: Actor;
  readonly opts: SleepOpts;
}

export type SleepReply =
  | { readonly ok: true; readonly result: SleepResult }
  | { readonly ok: false; readonly busy: boolean; readonly message: string; readonly stack?: string };

// Resolved from the package root, so a server run from TypeScript source starts the same built file.
const CHILD_ENTRY = fileURLToPath(new URL('../../dist/server/sleep-child.js', import.meta.url));

function failureOf(reply: SleepReply | undefined, code: number | null, signal: NodeJS.Signals | null): Error {
  if (!reply || reply.ok) return new Error(`sleep process ended without an answer (code ${code}, signal ${signal})`);
  // A lock the child could not get is the same retryable 503 an in-process sleep gave.
  if (reply.busy) return new StoreBusyError(reply.message);
  const failure = new Error(reply.message);
  if (reply.stack) failure.stack = reply.stack;
  return failure;
}

function runInChild(job: SleepJob): Promise<SleepResult> {
  const deadlineMs = envSleepTimeoutMs() ?? DEFAULT_SLEEP_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    // The child's stderr is the server's log, so Node's SQLite notice would repeat there on every sleep.
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD_ENTRY], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    let reply: SleepReply | undefined;
    let timedOut = false;
    // SIGKILL because the child is inside synchronous SQLite work and cannot run a handler; the OS drops its write lock.
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, deadlineMs);
    child.once('message', (message) => {
      // SAFETY: sleep-child.ts is the only writer on this channel and sends exactly one SleepReply.
      reply = message as SleepReply;
    });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    // 'close' and not 'exit': it waits for the channel to drain, so the reply is in hand and the child's store handles are gone.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new HttpError(504, `sleep did not finish within ${deadlineMs} ms and was stopped; the next sleep carries on from there`));
      else if (reply?.ok) resolve(reply.result);
      else reject(failureOf(reply, code, signal));
    });
    child.send(job);
  });
}

let turn: Promise<void> = Promise.resolve();

// One running and one waiting: each further sleep would only hold a request open behind work the waiting one already covers.
const MAX_SLEEPS_IN_LINE = 2;
const SLEEP_RETRY_AFTER_SEC = 30;
let inLine = 0;

/** `sleep` for the HTTP route: same result and errors, run outside the serving process and stopped at the deadline (10 minutes, or HIPPO_SLEEP_TIMEOUT_MS). */
export function sleepInChild(ctx: Context, opts: SleepOpts): Promise<SleepResult> {
  // The child reopens the store by path, which only SQLite has; any other store keeps sleep's own refusal.
  if (ctx.store && ctx.store.kind !== 'sqlite') return sleep(ctx, opts);
  if (inLine >= MAX_SLEEPS_IN_LINE) {
    return Promise.reject(new HttpError(503, 'a sleep is already running and another is waiting; retry when one has finished', SLEEP_RETRY_AFTER_SEC));
  }
  inLine += 1;
  const job: SleepJob = { hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, actor: ctx.actor, opts };
  // One sleep at a time, as on the server's single thread: a second request waits its turn and does not fight the first for the write lock.
  const run = turn.then(() => runInChild(job));
  // A failed sleep reaches its own request through `run`; the queue only needs to know the turn is over.
  turn = run.then(() => undefined, () => undefined).finally(() => { inLine -= 1; });
  return run;
}
