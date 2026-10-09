import { archiveRaw, type Context } from '../../api/index.js';
import { requireGroup, storeFor } from '../../store/index.js';
import type { ConnectorEvent } from '../../store/port.js';

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

/** Handles Slack `message_deleted`. The store logs the event in the archive's own transaction, so a crash cannot leave a retry
 *  answering `not_found` where `duplicate` is due. */
export async function handleMessageDeleted(ctx: Context, input: DeletionInput): Promise<DeletionResult> {
  const events = requireGroup(storeFor(ctx), 'connectorEvents');
  const event: ConnectorEvent = { connector: 'slack', eventId: input.eventId };
  // The tenant in the lookup is load-bearing: without it a deletion event from
  // tenant A could archive tenant B's raw row sharing the same artifact_ref.
  const target = await events.deletionTarget({
    event,
    artifactRef: `slack://${input.teamId}/${input.channelId}/${input.deletedTs}`,
    tenantId: ctx.tenantId,
  });
  if (target.seen) return { status: 'duplicate', memoryId: null };
  const memoryId = target.memoryId;
  if (!memoryId) {
    // No row to archive: the event is still marked seen, so a retry answers 'duplicate'.
    await events.markEventSeen(event);
    return { status: 'not_found', memoryId: null };
  }
  await archiveRaw(ctx, memoryId, `source_deleted:slack:${input.teamId}:${input.channelId}:${input.deletedTs}`, { event });
  return { status: 'archived', memoryId };
}
