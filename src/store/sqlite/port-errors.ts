// hippo.db's busy and locked codes leave the adapter as the port's StoreBusyError, so no layer above it reads a driver
// code. The driver's error stays as the cause and its text as the message.
import { isSqliteBusy } from '../../db/index.js';
import { errorMessage } from '../../base/util/log.js';
import { StoreBusyError } from '../port.js';

/** `error` in the port's terms: a busy or locked code becomes a StoreBusyError, and any other error is as thrown. */
export function portError<E>(error: E): E | StoreBusyError {
  return isSqliteBusy(error) ? new StoreBusyError(errorMessage(error), { cause: error }) : error;
}

/** `run`'s value, or its throw in the port's terms. */
export function inPortTerms<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw portError(error);
  }
}

/** `inPortTerms` for work that settles later. */
export async function inPortTermsAsync<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw portError(error);
  }
}
