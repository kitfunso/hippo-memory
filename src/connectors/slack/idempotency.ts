import type { DatabaseSyncLike } from '../../db.js';

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
