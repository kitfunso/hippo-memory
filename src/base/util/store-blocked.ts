// The store errors every layer may name: a path the serving store has no port for answers 501 on every surface,
// whichever adapter refused it.

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
