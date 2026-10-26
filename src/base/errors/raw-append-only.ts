import { BadRequestError } from './api-errors.js';

/** The refusal a delete of a raw row gets; a plain Error subclass, so it joins no HTTP status
 * family. */
export class RawAppendOnlyError extends Error {
  /** `cause` is the SQLite trigger's abort; a store with no trigger refuses with none. */
  constructor(cause?: Error) {
    super('raw is append-only', cause === undefined ? undefined : { cause });
  }
}

/** Forget refuses a raw row and the raw archive refuses every other kind; null when the removal
 * may go ahead. */
export function rawRemovalRefusal(
  row: { readonly id: string; readonly kind: string },
  archive: boolean,
): Error | null {
  if (archive)
    return row.kind === 'raw'
      ? null
      : new BadRequestError(`memory ${row.id} is not raw (kind=${row.kind})`);
  return row.kind === 'raw' ? new RawAppendOnlyError() : null;
}
