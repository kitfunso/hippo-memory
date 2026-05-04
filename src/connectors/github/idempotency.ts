import type { DatabaseSyncLike } from '../../db.js';

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

export function hasSeenKey(db: DatabaseSyncLike, idempotencyKey: string): boolean {
  const row = db.prepare(`SELECT 1 FROM github_event_log WHERE idempotency_key = ?`).get(idempotencyKey);
  return !!row;
}

export function markKeySeen(
  db: DatabaseSyncLike,
  args: { idempotencyKey: string; deliveryId: string; eventName: string; memoryId: string | null },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO github_event_log (idempotency_key, delivery_id, event_name, ingested_at, memory_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(args.idempotencyKey, args.deliveryId, args.eventName, new Date().toISOString(), args.memoryId);
}

export function lookupMemoryByKey(db: DatabaseSyncLike, idempotencyKey: string): string | null {
  const row = db.prepare(`SELECT memory_id FROM github_event_log WHERE idempotency_key = ?`).get(idempotencyKey) as
    | { memory_id: string | null }
    | undefined;
  return row?.memory_id ?? null;
}
