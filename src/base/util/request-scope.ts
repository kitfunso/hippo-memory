// A request's log id, and the deadline type its Context carries. A leaf module, so the logger can
// read the request id without importing the store layer.
import { AsyncLocalStorage } from 'node:async_hooks';

/** What the one ambient scope carries. */
interface RequestScope {
  /** Ties every log line written inside the scope to one request. */
  readonly requestId: string | undefined;
}

const DEFAULT_REQUEST_DEADLINE_MS = 120_000;

/** How long a request may run: DEFAULT_REQUEST_DEADLINE_MS, or the HIPPO_REQUEST_DEADLINE_MS value
 * the root read, where 0 turns it off. */
export function requestDeadlineMs(configured?: number): number {
  return configured ?? DEFAULT_REQUEST_DEADLINE_MS;
}

/**
 * When a request must be answered, and the store calls it still waits on: the store ends each of
 * those soon after `at`, with the outcome only it knows.
 */
export class RequestDeadline {
  /** Epoch milliseconds. */
  readonly at: number;
  #storeCalls = 0;
  #whenIdle: (() => void)[] = [];

  constructor(at: number) {
    this.at = at;
  }

  /** Counts `call` as one the request waits on until it settles. */
  track<T>(call: Promise<T>): Promise<T> {
    this.#storeCalls += 1;
    const done = (): void => {
      this.#storeCalls -= 1;
      if (this.#storeCalls > 0) return;
      for (const idle of this.#whenIdle.splice(0)) idle();
    };
    call.then(done, done);
    return call;
  }

  /**
   * Runs `fn` now, or once the last store call the request waits on has settled; every function
   * registered meanwhile runs, in order.
   */
  onceIdle(fn: () => void): void {
    if (this.#storeCalls === 0) fn();
    else this.#whenIdle.push(fn);
  }
}

/** What a root hands one request's calls: the deadline its reply waits on, and the signal that
 * fires past it. */
export interface RequestLimits {
  readonly deadline?: RequestDeadline | undefined;
  readonly signal?: AbortSignal | undefined;
}

// Only the log request id lives in AsyncLocalStorage; a request's deadline and signal ride on its
// Context.
export const requestScopes = new AsyncLocalStorage<RequestScope>();

/** The id of the request this code runs for, if any. */
export function currentRequestId(): string | undefined {
  return requestScopes.getStore()?.requestId;
}

/** Runs `fn` with `requestId` on every log line it writes, including the ones from timers and
 * promises it starts. */
export function runWithRequestId<T>(requestId: string | undefined, fn: () => T): T {
  return requestScopes.run({ requestId }, fn);
}
