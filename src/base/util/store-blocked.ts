// The store errors every layer may name: a path the serving store has no port for answers 501 on every surface,
// whichever adapter refused it, and a held lock answers 503.

/** A code path not ported to the store that serves the call; an adapter's refusal of its own files subclasses it. */
export class StoreBlockedError extends Error {
  constructor(
    readonly storeKind: string,
    message: string,
  ) {
    super(message);
    this.name = 'StoreBlockedError';
  }
}

/** A store that lacks a whole group of port methods; the same 501, and the log names the group. */
export class StoreNotPortedError extends StoreBlockedError {
  constructor(
    storeKind: string,
    readonly group: string,
  ) {
    super(storeKind, `the '${storeKind}' store has no '${group}' group; this code path is not ported to the store yet`);
    this.name = 'StoreNotPortedError';
  }
}

/** First line of a best-effort catch around a store read: an unported path must fail closed, not fall back silently. */
export function rethrowIfStoreBlocked<E>(err: E): void {
  if (err instanceof StoreBlockedError) throw err;
}

export const STORE_BUSY_MESSAGE = 'store busy (another hippo process holds the write lock); retry shortly';

/** A store behind the port throws this when its lock wait runs out, so the server answers 503 as it does for a busy
 * hippo.db; a store maps its driver's own busy errors to it, with the driver's error as the cause. */
export class StoreBusyError extends Error {
  constructor(message: string = STORE_BUSY_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreBusyError';
  }
}

/** A held lock in any store: every store reports one as a StoreBusyError. */
export function isStoreBusy<E>(error: E): boolean {
  return error instanceof StoreBusyError;
}
