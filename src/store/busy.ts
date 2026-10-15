// The busy half of the store port, apart from port.ts so that file stays under the size gate.
import { isSqliteBusy } from '../db/busy.js';

export const STORE_BUSY_MESSAGE = 'store busy (another hippo process holds the write lock); retry shortly';

/** A store behind the port throws this when its lock wait runs
 * out, so the server answers 503 as it does for a busy hippo.db. */
export class StoreBusyError extends Error {
  constructor(message: string = STORE_BUSY_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreBusyError';
  }
}

/** A held lock in any store: SQLite's busy codes or a port's StoreBusyError. */
export function isStoreBusy<E>(error: E): boolean {
  return error instanceof StoreBusyError || isSqliteBusy(error);
}
