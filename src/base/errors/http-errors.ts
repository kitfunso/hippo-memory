// Errors that carry an HTTP status. Transport-free, so the api and the store map them without importing node:http.

export class HttpError extends Error {
  status: number;
  /** Sent as the Retry-After header, so a refused caller knows when to come back. */
  readonly retryAfterSec: number | undefined;
  constructor(status: number, message: string, retryAfterSec?: number) {
    super(message);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * A request, or a store call it waited on, ran past the request's deadline; the reply carries `code` so a client
 * branches without parsing prose.
 */
export class DeadlineExceededError extends HttpError {
  readonly code = 'deadline_exceeded';
  constructor(message: string) {
    super(504, message);
  }
}

export class BodyTooLargeError extends Error {}

/** The body did not arrive in time. Its own class so mapApiError answers 408 and the server drops the socket. */
export class BodyTimeoutError extends Error {}

export const INTERNAL_ERROR_MESSAGE = 'internal server error';

/** The reply when a request under another store reaches code that still opens hippo.db. */
export const STORE_NOT_PORTED_MESSAGE = 'store_not_ported';
