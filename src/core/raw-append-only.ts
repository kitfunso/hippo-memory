/** The refusal a delete of a raw row gets; a plain Error subclass, so it joins no HTTP status family. */
export class RawAppendOnlyError extends Error {
  constructor(cause: Error) {
    super('raw is append-only', { cause });
  }
}
