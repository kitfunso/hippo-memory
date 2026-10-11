// Busy detection lives with the adapter, so the port names no SQLite error code.
import { isSqliteBusy } from '../../db/busy.js';
import { StoreBusyError } from '../port.js';

/** A held lock in any store: SQLite's busy codes or a port's StoreBusyError. */
export function isStoreBusy<E>(error: E): boolean {
  return error instanceof StoreBusyError || isSqliteBusy(error);
}
