import { remember, type Context, type RememberOpts } from '../../api.js';
import { markSlackEventSeen, markSlackEventSeenAt, slackEventMemory, slackEventRecord } from '../../store/connectors/slack.js';
import { RejectedValueError } from '../../rejection.js';
import { DuplicateEventError } from './idempotency.js';
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
 *   correct under two-worker concurrency.
 * - Empty-body messages return 'skipped' but still mark seen so a replay
 *   returns 'duplicate' rather than re-running the transform.
 */
export function ingestMessage(ctx: Context, input: IngestInput): IngestResult {
  // Idempotency check: if already seen, return the cached memory_id without
  // re-running the transform or hitting api.remember.
  const seen = slackEventRecord(ctx.hippoRoot, input.eventId);
  if (seen.seen) {
    // Empty-body events are marked seen with memory_id=NULL, so their replay returns the same 'skipped'
    // they first returned; a non-NULL memory_id means a memory was ingested, so 'duplicate'.
    return { status: seen.memoryId === null ? 'skipped' : 'duplicate', memoryId: seen.memoryId };
  }

  const opts = messageToRememberOpts(input);
  if (!opts) {
    markSlackEventSeen(ctx.hippoRoot, input.eventId, null);
    return { status: 'skipped', memoryId: null };
  }

  // Atomic write: the afterWrite callback runs inside writeEntry's SAVEPOINT,
  // so the memory row and the slack_event_log row commit (or roll back)
  // together. Slack's 1-minute retry window can no longer produce a duplicate
  // via the crash-between-handles race.
  try {
    return rememberWithEventLog(ctx, input.eventId, opts);
  } catch (e) {
    if (e instanceof DuplicateEventError) return lostRaceResult(ctx, input.eventId);
    if (e instanceof RejectedValueError) return rejectedValueResult(ctx, input.eventId);
    throw e;
  }
}

function rememberWithEventLog(
  ctx: Context,
  eventId: string,
  opts: RememberOpts,
): IngestResult {
  // No `|| 'connector:slack'` fallback: the caller always builds ctx with the connector subject, and with
  // an object-shaped Context.actor an OR-fallback would never fire anyway.
  const result = remember(
    { ...ctx, store: undefined }, // the event log row commits with the memory on hippo.db's own handle, never through a store
    {
      ...opts,
      untrusted: true,
      afterWrite: (innerDb, memoryId) => {
        if (!markSlackEventSeenAt(innerDb, eventId, memoryId)) {
          // Two-worker race: another writer reserved this event_id between
          // the pre-check and the write. Throw to roll back the SAVEPOINT
          // in writeEntry — the memory row gets discarded, idempotency
          // holds, exactly one memory exists for this event_id.
          throw new DuplicateEventError(eventId);
        }
      },
    },
  );
  return { status: 'ingested', memoryId: result.id };
}

function lostRaceResult(ctx: Context, eventId: string): IngestResult {
  // The other worker's memory row is already committed. Return its id
  // so the caller behaves identically to the fast-path 'duplicate' branch.
  return { status: 'skipped_duplicate', memoryId: slackEventMemory(ctx.hippoRoot, eventId) };
}

function rejectedValueResult(ctx: Context, eventId: string): IngestResult {
  // A tombstone hit is a PERMANENT skip: a DLQ retry would hit the same refusal forever, so mark the
  // event seen like the empty-body branch above and let a Slack retry ack as done, not error.
  markSlackEventSeen(ctx.hippoRoot, eventId, null);
  return { status: 'skipped', memoryId: null };
}
