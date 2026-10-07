// A leaf module, so http-util can map this error to a 501 without importing db/open, whose migrations reach back to http-util.

/** Thrown by a hippo.db open inside a request served from another store: the code path is not ported to the store port yet. */
export class SqliteBlockedError extends Error {
  constructor(readonly storeKind: string, message = `hippo.db is not opened while the '${storeKind}' store serves this request; this code path is not ported to the store yet`) {
    super(message);
    this.name = 'SqliteBlockedError';
  }
}

/** A store that lacks a whole group of port methods; it maps to the same 501, and the log names the group instead of hippo.db. */
export class StoreNotPortedError extends SqliteBlockedError {
  constructor(storeKind: string, readonly group: string) {
    super(storeKind, `the '${storeKind}' store has no '${group}' reads; this code path is not ported to the store yet`);
    this.name = 'StoreNotPortedError';
  }
}
