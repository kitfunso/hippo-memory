import type { Context } from '../../api/index.js';
import { requireGroup, storeFor } from '../../store/index.js';
import type { ConnectorEvent } from '../../store/port.js';
import { rememberWithEventLog, type IngestResult } from '../ingest.js';
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

/** Ingests a Slack message as a kind='raw' memory once per event id (Slack redelivers within a minute); the pre-check is only the fast path,
 *  the store logs the event in the memory's own transaction, which holds when two workers race. An empty body is logged with no memory. */
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

  return rememberWithEventLog(ctx, event, messageToRememberOpts(input));
}
