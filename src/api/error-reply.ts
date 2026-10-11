// The one error-to-reply map the HTTP server and the MCP transports share, so a status never depends on which front end caught the error.
import { ApiError } from '../core/api-errors.js';
import { BodyTimeoutError, BodyTooLargeError, HttpError, INTERNAL_ERROR_MESSAGE, STORE_NOT_PORTED_MESSAGE } from '../util/http-util.js';
import { SqliteBlockedError } from '../util/sqlite-blocked.js';

/** The status and client-facing message for one failed request. */
export interface ApiErrorReply {
  status: number;
  message: string;
}

/** Maps by class so rewording a message never moves a status; an untyped error is a 500 whose text stays in the server log. */
export function mapApiError<E>(err: E): ApiErrorReply {
  // An add-on can build an HttpError from any number, and writeHead throws on one outside 100-999.
  if (err instanceof HttpError && !(Number.isInteger(err.status) && err.status >= 100 && err.status <= 999)) {
    return { status: 500, message: INTERNAL_ERROR_MESSAGE };
  }
  if (err instanceof HttpError || err instanceof ApiError) return { status: err.status, message: err.message };
  if (err instanceof BodyTooLargeError) return { status: 413, message: err.message };
  if (err instanceof BodyTimeoutError) return { status: 408, message: err.message };
  if (err instanceof SqliteBlockedError) return { status: 501, message: STORE_NOT_PORTED_MESSAGE };
  return { status: 500, message: INTERNAL_ERROR_MESSAGE };
}
