import type { DatabaseSyncLike } from '../../db.js';

/**
 * Thrown by the ingest afterWrite hook when a concurrent worker has already
 * inserted slack_event_log for the same event_id. The throw propagates out of
 * writeEntry's SAVEPOINT, rolling back the duplicate memory write so exactly
 * one memory row exists per Slack event_id even under two-worker races.
 *
 * Caller maps to `{status: 'skipped_duplicate'}` at the public API boundary.
 */
export class DuplicateEventError extends Error {
  readonly eventId: string;
  constructor(eventId: string) {
    super(`duplicate slack event_id: ${eventId}`);
    this.name = 'DuplicateEventError';
    this.eventId = eventId;
  }
}

export function hasSeenEvent(db: DatabaseSyncLike, eventId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM slack_event_log WHERE event_id = ?`).get(eventId);
  return !!row;
}

export function markEventSeen(db: DatabaseSyncLike, eventId: string, memoryId: string | null): void {
  db.prepare(`INSERT OR IGNORE INTO slack_event_log (event_id, ingested_at, memory_id) VALUES (?, ?, ?)`)
    .run(eventId, new Date().toISOString(), memoryId);
}

export function lookupMemoryByEvent(db: DatabaseSyncLike, eventId: string): string | null {
  const row = db.prepare(`SELECT memory_id FROM slack_event_log WHERE event_id = ?`).get(eventId) as
    | { memory_id: string | null }
    | undefined;
  return row?.memory_id ?? null;
}
