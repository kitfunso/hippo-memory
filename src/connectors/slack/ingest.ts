import { remember, type Context, type RememberOpts } from '../../api.js';
import { requireGroup, storeFor } from '../../store-port.js';
import type { ConnectorEvent } from '../../store/port.js';
import { RejectedValueError } from '../../store/rejection.js';
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

/** Ingests a Slack message as a kind='raw' memory, once per event id: Slack redelivers within a minute.
 *  The pre-check is only the fast path; the store logs the event in the memory's own transaction, which is what holds when two workers race.
 *  An empty body is logged with no memory, so its replay skips the transform. */
export async function ingestMessage(ctx: Context, input: IngestInput): Promise<IngestResult> {
  const events = requireGroup(storeFor(ctx), 'connectorEvents');
  const event: ConnectorEvent = { connector: 'slack', eventId: input.eventId };
  // Idempotency check: if already seen, return the cached memory_id without
  // re-running the transform or hitting api.remember.
  const seen = await events.eventRecord(event);
  if (seen.seen) {
    // Empty-body events are marked seen with memory_id=NULL, so their replay returns the same 'skipped'
    // they first returned; a non-NULL memory_id means a memory was ingested, so 'duplicate'.
    return { status: seen.memoryId === null ? 'skipped' : 'duplicate', memoryId: seen.memoryId };
  }

  const opts = messageToRememberOpts(input);
  if (!opts) {
    await events.markEventSeen(event);
    return { status: 'skipped', memoryId: null };
  }

  try {
    return await rememberWithEventLog(ctx, event, opts);
  } catch (e) {
    if (!(e instanceof RejectedValueError)) throw e;
    // A tombstone hit is a PERMANENT skip: a DLQ retry would hit the same refusal forever, so mark the
    // event seen like the empty-body branch above and let a Slack retry ack as done, not error.
    await events.markEventSeen(event);
    return { status: 'skipped', memoryId: null };
  }
}

async function rememberWithEventLog(ctx: Context, event: ConnectorEvent, opts: RememberOpts): Promise<IngestResult> {
  // No `|| 'connector:slack'` fallback: the caller always builds ctx with the connector subject, and with
  // an object-shaped Context.actor an OR-fallback would never fire anyway.
  const result = await remember(ctx, { ...opts, untrusted: true, event });
  // Another worker logged this event between the pre-check and the write: its memory stands and ours was not stored.
  if (result.duplicate) return { status: 'skipped_duplicate', memoryId: result.duplicate.memoryId };
  return { status: 'ingested', memoryId: result.id };
}
