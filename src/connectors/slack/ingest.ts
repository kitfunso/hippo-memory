import { remember, type Context } from '../../api.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import {
  hasSeenEvent,
  markEventSeen,
  lookupMemoryByEvent,
  DuplicateEventError,
} from './idempotency.js';
import { messageToRememberOpts } from './transform.js';
import type { ChannelMeta } from './scope.js';
import type { SlackMessageEvent } from './types.js';

export interface IngestInput {
  teamId: string;
  channel: ChannelMeta;
  message: SlackMessageEvent;
  /** Slack event_id for the envelope (or for backfill, a synthesized stable id). */
  eventId: string;
}

export type IngestStatus = 'ingested' | 'duplicate' | 'skipped' | 'skipped_duplicate';

export interface IngestResult {
  status: IngestStatus;
  memoryId: string | null;
}

/**
 * Ingest a Slack message into hippo as a kind='raw' memory.
 *
 * - Idempotency-checked via slack_event_log (Slack retries within 1 minute).
 * - The memory write and the slack_event_log mark commit atomically through
 *   `api.remember`'s `afterWrite` hook — a crash between the two cannot
 *   produce a duplicate on the next retry.
 * - The afterWrite hook uses an explicit `INSERT OR IGNORE` + changes-check:
 *   if a concurrent worker beat us to slack_event_log between the pre-check
 *   and the SAVEPOINT, we throw `DuplicateEventError` to roll back the memory
 *   write. The pre-check `hasSeenEvent` stays as a fast path for the common
 *   already-seen case, but the afterWrite throw is what makes idempotency
 *   correct under two-worker concurrency (v0.39 commit 3 fix).
 * - Empty-body messages return 'skipped' but still mark seen so a replay
 *   returns 'duplicate' rather than re-running the transform.
 */
export function ingestMessage(ctx: Context, input: IngestInput): IngestResult {
  // Idempotency check: if already seen, return the cached memory_id without
  // re-running the transform or hitting api.remember.
  const db = openHippoDb(ctx.hippoRoot);
  try {
    if (hasSeenEvent(db, input.eventId)) {
      return { status: 'duplicate', memoryId: lookupMemoryByEvent(db, input.eventId) };
    }
  } finally {
    closeHippoDb(db);
  }

  const opts = messageToRememberOpts(input);
  if (!opts) {
    const db2 = openHippoDb(ctx.hippoRoot);
    try {
      markEventSeen(db2, input.eventId, null);
    } finally {
      closeHippoDb(db2);
    }
    return { status: 'skipped', memoryId: null };
  }

  // Atomic write: the afterWrite callback runs inside writeEntry's SAVEPOINT,
  // so the memory row and the slack_event_log row commit (or roll back)
  // together. Slack's 1-minute retry window can no longer produce a duplicate
  // via the crash-between-handles race.
  try {
    const result = remember(
      { ...ctx, actor: ctx.actor || 'connector:slack' },
      {
        ...opts,
        afterWrite: (innerDb, memoryId) => {
          const inserted = innerDb
            .prepare(
              `INSERT OR IGNORE INTO slack_event_log (event_id, ingested_at, memory_id) VALUES (?, ?, ?)`,
            )
            .run(input.eventId, new Date().toISOString(), memoryId);
          if ((Number(inserted.changes ?? 0)) === 0) {
            // Two-worker race: another writer reserved this event_id between
            // the pre-check and the write. Throw to roll back the SAVEPOINT
            // in writeEntry — the memory row gets discarded, idempotency
            // holds, exactly one memory exists for this event_id.
            throw new DuplicateEventError(input.eventId);
          }
        },
      },
    );
    return { status: 'ingested', memoryId: result.id };
  } catch (e) {
    if (e instanceof DuplicateEventError) {
      // The other worker's memory row is already committed. Return its id
      // so the caller behaves identically to the fast-path 'duplicate' branch.
      const db3 = openHippoDb(ctx.hippoRoot);
      try {
        const cachedId = lookupMemoryByEvent(db3, input.eventId);
        return { status: 'skipped_duplicate', memoryId: cachedId };
      } finally {
        closeHippoDb(db3);
      }
    }
    throw e;
  }
}
