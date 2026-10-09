// The one ambient scope of a request. A leaf module, so the logger can read the request id without importing the store layer.
import { AsyncLocalStorage } from 'node:async_hooks';

/** What every scope carries; the store layer's RequestStores is one, and adds its handles. */
export interface RequestScope {
  /** Ties every log line written inside the scope to one request. */
  readonly requestId: string | undefined;
}

export const requestScopes = new AsyncLocalStorage<RequestScope>();

/** The id of the request this code runs for, if any. */
export function currentRequestId(): string | undefined {
  return requestScopes.getStore()?.requestId;
}

/** Runs `fn` with `requestId` on every log line it writes, including the ones from timers and promises it starts. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestScopes.run({ requestId }, fn);
}
