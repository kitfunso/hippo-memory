// The one ambient scope of a request. A leaf module, so the logger can read the request id without importing the store layer.
import { AsyncLocalStorage } from 'node:async_hooks';

/** What every scope carries; the store layer's RequestStores is one, and adds its handles. */
export interface RequestScope {
  /** Ties every log line written inside the scope to one request. */
  readonly requestId: string | undefined;
  /** Set for a served request that must be answered by a given time. */
  readonly deadline?: RequestDeadline | undefined;
}

/** When a request must be answered, and the store calls it still waits on: the store ends each of those soon after `at`, with the outcome only it knows. */
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

  /** Runs `fn` now, or once the last store call the request waits on has settled; every function registered meanwhile runs, in order. */
  onceIdle(fn: () => void): void {
    if (this.#storeCalls === 0) fn();
    else this.#whenIdle.push(fn);
  }
}

export const requestScopes = new AsyncLocalStorage<RequestScope>();

/** The id of the request this code runs for, if any. */
export function currentRequestId(): string | undefined {
  return requestScopes.getStore()?.requestId;
}

/** The deadline of the request this code runs for, if it has one. */
export function currentDeadline(): RequestDeadline | undefined {
  return requestScopes.getStore()?.deadline;
}

/** Runs `fn` with `requestId` on every log line it writes, including the ones from
 * timers and promises it starts. `deadline` reaches every store call made inside. */
export function runWithRequestId<T>(requestId: string, fn: () => T, deadline?: RequestDeadline): T {
  return requestScopes.run({ requestId, deadline }, fn);
}
