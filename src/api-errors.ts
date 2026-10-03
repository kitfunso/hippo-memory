/** Errors whose HTTP status is part of the API contract; the server maps by class, so message text can change freely. */

export type ApiErrorStatus = 400 | 403 | 404 | 409;

/** Base class: an error the caller caused, carrying the status the HTTP layer answers with. */
export abstract class ApiError extends Error {
  abstract readonly status: ApiErrorStatus;
}

/** The request cannot be applied as given: bad input, or a state this route reports as 400. */
export class BadRequestError extends ApiError {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** The actor's role or identity does not allow the operation. */
export class ForbiddenError extends ApiError {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** The named row does not exist for this tenant. */
export class NotFoundError extends ApiError {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The row exists but its current state forbids the change (already superseded, closed, or decided). */
export class ConflictError extends ApiError {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
