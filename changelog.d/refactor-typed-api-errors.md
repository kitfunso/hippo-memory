### Security

- **`hippo serve` no longer sends internal error text to clients.** An error the server does not recognise now returns 500 with `{"error": "internal server error", "requestId": "..."}`, and the real cause goes to the server log at `error` level under the same request id. It used to return 400 with the raw message, which could carry file paths or SQLite text.

### Changed

- **HTTP status codes follow typed error classes, not message text.** Domain code throws `BadRequestError` (400), `ForbiddenError` (403), `NotFoundError` (404) or `ConflictError` (409) from `src/api-errors.ts`, and the server maps by class. Rewording a message can no longer move a status. Every message keeps its exact text, and every status a client could get before stays the same, except that unrecognised failures are now 500 instead of 400.
