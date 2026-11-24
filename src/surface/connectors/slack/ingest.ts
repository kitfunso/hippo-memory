import type { ConnectorEvent } from '../../../base/ports/store.js';
import { rememberWithEventLog, type ConnectorContext, type IngestResult } from '../ingest.js';
import { messageToRememberOpts } from './transform.js';
import type { ChannelMeta } from './scope.js';
import type { SlackMessageEvent } from './types.js';

export interface IngestInput {
  teamId: string;
  channel: ChannelMeta;
  message: SlackMessageEvent;
  eventId: string;
}

/** Ingests a Slack message as a kind='raw' memory once per event id (Slack redelivers within a
 * minute); the pre-check is only the fast path, the store logs the event in the memory's own
 * transaction, which holds when two workers race. An empty body is logged with no memory. */
export async function ingestMessage(
  ctx: ConnectorContext,
  input: IngestInput,
): Promise<IngestResult> {
  const events = ctx.store.connectorEvents;
  const event: ConnectorEvent = { connector: 'slack', eventId: input.eventId };
  const seen = await events.eventRecord(event);
  if (seen.seen) {
    return { status: seen.memoryId === null ? 'skipped' : 'duplicate', memoryId: seen.memoryId };
  }

  return rememberWithEventLog(ctx, event, messageToRememberOpts(input));
}
