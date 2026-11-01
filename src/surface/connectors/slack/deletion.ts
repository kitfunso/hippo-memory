import { archiveRowForEvent } from '../../../api/hippo-db/connector-events.js';
import type { ConnectorEvent } from '../../../base/records/connectors.js';
import type { ConnectorContext } from '../ingest.js';

export interface DeletionInput {
  teamId: string;
  channelId: string;
  deletedTs: string;
  eventId: string;
}

export type DeletionStatus = 'archived' | 'not_found' | 'duplicate';

export interface DeletionResult {
  status: DeletionStatus;
  memoryId: string | null;
}

/** Handles Slack `message_deleted`. The store logs the event in the archive's own transaction,
 * so a crash cannot leave a retry answering `not_found` where `duplicate` is due. */
export async function handleMessageDeleted(
  ctx: ConnectorContext,
  input: DeletionInput,
): Promise<DeletionResult> {
  const event: ConnectorEvent = { connector: 'slack', eventId: input.eventId };
  const artifactRef = `slack://${input.teamId}/${input.channelId}/${input.deletedTs}`;
  const reason = `source_deleted:slack:${input.teamId}:${input.channelId}:${input.deletedTs}`;
  return archiveRowForEvent(ctx, event, artifactRef, reason);
}
