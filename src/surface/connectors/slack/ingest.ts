import type { ConnectorEvent } from '../../../base/records/connectors.js';
import { rememberOncePerEvent } from '../../../api/hippo-db/connector-writes.js';
import type { ConnectorContext, IngestResult } from '../ingest.js';
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

/** Ingests a Slack message as a kind='raw' memory once per event id (Slack redelivers within a
 * minute); the pre-check is only the fast path, the store logs the event in the memory's own
 * transaction, which holds when two workers race. An empty body is logged with no memory. */
export async function ingestMessage(
  ctx: ConnectorContext,
  input: IngestInput,
): Promise<IngestResult> {
  const event: ConnectorEvent = { connector: 'slack', eventId: input.eventId };
  const done = await rememberOncePerEvent(ctx, event, () => messageToRememberOpts(input));
  if (done.status !== 'logged') return done;
  // An empty body was logged with no memory, so its replay answers the 'skipped' it first did.
  return { status: done.memoryId === null ? 'skipped' : 'duplicate', memoryId: done.memoryId };
}
