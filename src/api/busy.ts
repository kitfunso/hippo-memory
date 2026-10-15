// Busy detection sits above the port so api code names no SQLite module.
import { isSqliteBusy } from '../db/busy.js';
import { StoreBusyError } from '../store/port.js';

/** A held lock in any store: SQLite's busy codes or a port's StoreBusyError. */
export function isStoreBusy<E>(error: E): boolean {
  return error instanceof StoreBusyError || isSqliteBusy(error);
}
