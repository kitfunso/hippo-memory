// The ledger writer's reads of `delivery_events` live in the data layer, not beside the writer.
import type { DatabaseSyncLike } from '../db.js';

/** Id and timestamp of every numbered row of one event type in a session, oldest id first. */
export function numberedEventTimes(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string | null,
  eventType: 'prompt-submit' | 'pinned-manual' | 'pre-compact' | 'compact-resume',
): Array<{ id: number; ts: string }> {
  // SAFETY: rows carry exactly the `id` and `ts` columns selected.
  return db.prepare(`
    SELECT id, ts FROM delivery_events
    WHERE tenant_id = ? AND session_id = ? AND event_type = ? AND turn_seq IS NOT NULL
    ORDER BY id
  `).all(tenantId, sessionId, eventType) as Array<{ id: number; ts: string }>;
}
