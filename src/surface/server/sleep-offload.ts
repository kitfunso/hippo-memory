// POST /v1/sleep and the MCP auto-sleep run their consolidation in a child process, so the server
// keeps answering and a stuck run can be stopped.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type Actor, type SleepOptions, type SleepResult, type Context } from '../../api/index.js';
import { envSleepTimeoutMs } from '../../base/util/env.js';
import { HttpError, STORE_NOT_PORTED_MESSAGE } from '../../base/errors/http-errors.js';
import { replyError, type FailureReply } from './failure-reply.js';
import type { ServeOptions } from './types.js';

const DEFAULT_SLEEP_DEADLINE_MS = 600_000;

/** What the child needs to rebuild the request's context (the store handle itself cannot cross a
 * process boundary), or the store an auto-sleep consolidates. */
export type SleepJob =
  | {
      readonly kind: 'sleep';
      readonly hippoRoot: string;
      readonly tenantId: string;
      readonly actor: Actor;
      readonly opts: SleepOptions;
    }
  | { readonly kind: 'consolidate'; readonly hippoRoot: string };

/** A job as the child receives it, with the epoch ms at which the server stops it, so work after
 * the sleep stops first. */
export type SleepMessage = SleepJob & { readonly deadline: number };

export type SleepReply<R = SleepResult> = { readonly ok: true; readonly result: R } | FailureReply;

// Resolved from the package root, so a server run from TypeScript source starts the same built
// file.
const CHILD_ENTRY = fileURLToPath(
  new URL('../../../dist/surface/server/sleep-child.js', import.meta.url),
);

/** The shape check for what crosses the IPC channel; the result's own fields are the API's to
 * define. */
export function isSleepReply<R, M>(message: M): message is M & SleepReply<R> {
  if (typeof message !== 'object' || message === null || !('ok' in message)) return false;
  if (message.ok === true) {
    return 'result' in message && typeof message.result === 'object' && message.result !== null;
  }
  return (
    message.ok === false &&
    'busy' in message &&
    typeof message.busy === 'boolean' &&
    'message' in message &&
    typeof message.message === 'string'
  );
}

/** How a child's run ended, held as one value so no reader sees a mix of flags. */
type Unanswered =
  | { readonly kind: 'failed'; readonly reply: FailureReply }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'closed' };
type ChildEnd<R> = { readonly kind: 'answered'; readonly result: R } | Unanswered;

type ChildEvent<R> =
  | { readonly kind: 'reply'; readonly reply: SleepReply<R> }
  | { readonly kind: 'malformed' | 'deadline' | 'close' };

// The failed-versus-deadline order lives in this precedence, not in the type.
function settle<R>(end: ChildEnd<R> | undefined, event: ChildEvent<R>): ChildEnd<R> {
  if (end?.kind === 'answered') return end;
  switch (event.kind) {
    case 'reply':
      if (event.reply.ok) return { kind: 'answered', result: event.reply.result };
      return end ?? { kind: 'failed', reply: event.reply };
    case 'malformed':
      return end ?? { kind: 'malformed' };
    case 'deadline':
      return { kind: 'deadline' };
    case 'close':
      return end ?? { kind: 'closed' };
  }
}

/** A child's answer, settled by its reply, and its end, which comes after the work it does once
 * it has replied. */
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
    // The child's stderr is the server's log, so Node's experimental-module notice would repeat
    // there on every sleep.
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD_ENTRY], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    let end: ChildEnd<R> | undefined;
    // SIGKILL because the child is inside synchronous hippo.db work and cannot run a handler; the
    // OS drops its write lock.
    const timer = setTimeout(() => {
      end = settle(end, { kind: 'deadline' });
      child.kill('SIGKILL');
    }, deadlineMs);
    child.once('message', (message) => {
      end = settle(
        end,
        isSleepReply<R, typeof message>(message)
          ? { kind: 'reply', reply: message }
          : { kind: 'malformed' },
      );
      if (end.kind === 'answered') resolve(end.result);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      ended();
      reject(err);
    });
    // 'close' and not 'exit': it waits for the channel to drain, so the reply is in hand and the
    // child's store handles are gone.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      ended();
      end = settle(end, { kind: 'close' });
      if (end.kind !== 'answered') reject(unansweredFailure(end, deadlineMs, code, signal));
    });
    child.send({ ...job, deadline: Date.now() + deadlineMs } satisfies SleepMessage);
  });
}

/** Why a child that closed without a good reply failed. */
function unansweredFailure(
  end: Unanswered,
  deadlineMs: number,
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  switch (end.kind) {
    case 'deadline':
      return new HttpError(
        504,
        `sleep did not finish within ${deadlineMs} ms and was stopped; the next sleep carries on from there`,
      );
    case 'malformed':
      return new Error(
        `sleep process sent a reply that is not a sleep result (code ${code}, signal ${signal})`,
      );
    case 'failed':
      return replyError(end.reply);
    case 'closed':
      return new Error(`sleep process ended without an answer (code ${code}, signal ${signal})`);
  }
}

// One running and one waiting: each further sleep would only hold a request open behind work the
// waiting one already covers.
const MAX_SLEEPS_IN_LINE = 2;
const SLEEP_RETRY_AFTER_SEC = 30;
const OWN_SLEEP_ROOM = 1;

const ownRun = <R>(answer: Promise<R>): ChildRun<R> => ({
  answer,
  ended: answer.then(
    () => undefined,
    () => undefined,
  ),
});

/** A server's sleeps, one at a time in a child process: POST /v1/sleep and the auto-sleep a
 * write starts share it. */
export interface SleepQueue {
  readonly sleep: (ctx: Context, opts: SleepOptions) => Promise<SleepResult>;
  /** The auto-sleep's consolidation; auto-sleep only starts on a hippo.db store. */
  readonly consolidate: () => Promise<void>;
  /** Resolves once every sleep in line has ended, each by its deadline at the latest; it never
   * rejects. */
  readonly settled: () => Promise<void>;
}

export function createSleepQueue(
  hippoRoot: string,
  onHippoDb: boolean,
  ownSleep?: ServeOptions['sleep'],
): SleepQueue {
  const { inTurn, settled } = sleepLine();
  return {
    sleep: (ctx, opts) => {
      if (onHippoDb) {
        return inTurn<SleepResult>(
          () =>
            runInChild({
              kind: 'sleep',
              hippoRoot,
              tenantId: ctx.tenantId,
              actor: ctx.actor,
              opts,
            }),
          MAX_SLEEPS_IN_LINE,
        );
      }
      if (ownSleep !== undefined) {
        return inTurn<SleepResult>(() => ownRun(ownSleep(ctx, opts)), OWN_SLEEP_ROOM);
      }
      return Promise.reject(new HttpError(501, STORE_NOT_PORTED_MESSAGE));
    },
    consolidate: async () => {
      await inTurn<unknown>(
        () => runInChild({ kind: 'consolidate', hippoRoot }),
        MAX_SLEEPS_IN_LINE,
      );
    },
    settled,
  };
}

interface SleepLine {
  readonly inTurn: <R>(start: () => ChildRun<R>, room: number) => Promise<R>;
  readonly settled: () => Promise<void>;
}

function sleepLine(): SleepLine {
  let turn: Promise<void> = Promise.resolve();
  let inLine = 0;
  const inTurn = <R>(start: () => ChildRun<R>, room: number): Promise<R> => {
    if (inLine >= room) {
      return Promise.reject(
        new HttpError(
          503,
          room === 1
            ? 'a sleep is already running; retry when it has finished'
            : 'a sleep is already running and another is waiting; retry when one has finished',
          SLEEP_RETRY_AFTER_SEC,
        ),
      );
    }
    inLine += 1;
    const child = turn.then(start);
    turn = child
      .then(
        (run) => run.ended,
        () => undefined,
      )
      .finally(() => {
        inLine -= 1;
      });
    return child.then((run) => run.answer);
  };
  return { inTurn, settled: () => turn };
}
