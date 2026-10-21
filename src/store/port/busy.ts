export const STORE_BUSY_MESSAGE = 'store busy (another hippo process holds the write lock); retry shortly';

/** A store behind the port throws this when its lock wait runs out, so the server answers 503 as it does for a busy
 * hippo.db; a store maps its driver's own busy errors to it, with the driver's error as the cause. */
export class StoreBusyError extends Error {
  constructor(message: string = STORE_BUSY_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreBusyError';
  }
}

/** A held lock in any store: every store reports one as a StoreBusyError. */
export function isStoreBusy<E>(error: E): boolean {
  return error instanceof StoreBusyError;
}
