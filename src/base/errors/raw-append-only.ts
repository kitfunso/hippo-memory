/** The refusal a delete of a raw row gets; a plain Error subclass, so it joins no HTTP status family. */
export class RawAppendOnlyError extends Error {
  /** `cause` is the SQLite trigger's abort; a store with no trigger refuses with none. */
  constructor(cause?: Error) {
    super('raw is append-only', cause === undefined ? undefined : { cause });
  }
}
