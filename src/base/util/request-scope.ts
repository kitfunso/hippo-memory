import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestScope {
  readonly requestId: string | undefined;
}

const DEFAULT_REQUEST_DEADLINE_MS = 120_000;

/** How long a request may run: 120 s, or the HIPPO_REQUEST_DEADLINE_MS value the root read,
 * where 0 turns it off. */
export function requestDeadlineMs(configured?: number): number {
  return configured ?? DEFAULT_REQUEST_DEADLINE_MS;
}

/**
 * When a request must be answered, and the store calls it still waits on: the store ends each of
 * those soon after `at`, with the outcome only it knows.
 */
export class RequestDeadline {
  readonly at: number;
  #storeCalls = 0;
  #whenIdle: (() => void)[] = [];

  constructor(at: number) {
    this.at = at;
  }

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
