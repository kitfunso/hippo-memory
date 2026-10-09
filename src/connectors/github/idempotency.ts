export { eventSeenAt as hasSeenKey, eventMemoryAt as lookupMemoryByKey, logEventAt as markKeySeen } from '../../store/connectors/github.js';

/**
 * Thrown by ingest's afterWrite hook when a concurrent worker has already
 * inserted github_event_log for the same idempotency_key. Roll back the
 * SAVEPOINT so exactly one memory row exists per key.
 */
export class DuplicateIdempotencyError extends Error {
  readonly idempotencyKey: string;
  constructor(idempotencyKey: string) {
    super(`duplicate github idempotency_key: ${idempotencyKey}`);
    this.name = 'DuplicateIdempotencyError';
    this.idempotencyKey = idempotencyKey;
  }
}
