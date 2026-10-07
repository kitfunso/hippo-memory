// A leaf module, so http-util can map this error to a 501 without importing db/open, whose migrations reach back to http-util.

/** Thrown by a hippo.db open inside a request served from another store: the code path is not ported to the store port yet. */
export class SqliteBlockedError extends Error {
  constructor(readonly storeKind: string) {
    super(`hippo.db is not opened while the '${storeKind}' store serves this request; this code path is not ported to the store yet`);
    this.name = 'SqliteBlockedError';
  }
}
