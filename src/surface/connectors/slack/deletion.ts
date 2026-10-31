import { rawArchiveForEvent } from '../../../api/index.js';
import { deletionTarget, markConnectorEventSeen } from '../../../api/hippo-db/connector-events.js';
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
  const target = await deletionTarget(ctx, event, artifactRef);
  if (target.seen) return { status: 'duplicate', memoryId: null };
  const memoryId = target.memoryId;
  if (!memoryId) {
    // No row to archive: the event is still marked seen, so a retry answers 'duplicate'.
    await markConnectorEventSeen(ctx, event);
    return { status: 'not_found', memoryId: null };
  }
  const reason = `source_deleted:slack:${input.teamId}:${input.channelId}:${input.deletedTs}`;
  await rawArchiveForEvent(ctx, memoryId, reason, event);
  return { status: 'archived', memoryId };
}
