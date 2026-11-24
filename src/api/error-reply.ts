import { ApiError } from '../base/errors/api-errors.js';
import {
  BodyTimeoutError,
  BodyTooLargeError,
  HttpError,
  INTERNAL_ERROR_MESSAGE,
  STORE_NOT_PORTED_MESSAGE,
} from '../base/errors/http-errors.js';
import { StoreBlockedError } from '../base/util/store-blocked.js';
import { isStoreBusy, STORE_BUSY_MESSAGE } from '../base/ports/store.js';

/** The status and client-facing message for one failed request. */
export interface ApiErrorReply {
  status: number;
  message: string;
}

/**
 * Maps by class so rewording a message never moves a status; an untyped error is a 500 whose text
 * stays in the server log.
 */
export function mapApiError<E>(err: E): ApiErrorReply {
  if (isStoreBusy(err)) return { status: 503, message: STORE_BUSY_MESSAGE };
  if (
    err instanceof HttpError &&
    !(Number.isInteger(err.status) && err.status >= 100 && err.status <= 999)
  ) {
    return { status: 500, message: INTERNAL_ERROR_MESSAGE };
  }
  if (err instanceof HttpError || err instanceof ApiError) {
    return { status: err.status, message: err.message };
  }
  if (err instanceof BodyTooLargeError) return { status: 413, message: err.message };
  if (err instanceof BodyTimeoutError) return { status: 408, message: err.message };
  if (err instanceof StoreBlockedError) return { status: 501, message: STORE_NOT_PORTED_MESSAGE };
  return { status: 500, message: INTERNAL_ERROR_MESSAGE };
}
