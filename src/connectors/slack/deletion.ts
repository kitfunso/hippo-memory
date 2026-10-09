import { archiveRaw, type Context } from '../../api.js';
import { markSlackEventSeen, slackDeletionTarget } from '../../store/connectors/slack.js';

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
export function handleMessageDeleted(ctx: Context, input: DeletionInput): DeletionResult {
  // The tenant in the lookup is load-bearing: without it a deletion event from
  // tenant A could archive tenant B's raw row sharing the same artifact_ref.
  const target = slackDeletionTarget(ctx.hippoRoot, {
    eventId: input.eventId,
    artifactRef: `slack://${input.teamId}/${input.channelId}/${input.deletedTs}`,
    tenantId: ctx.tenantId,
  });
  if (target.seen) return { status: 'duplicate', memoryId: null };
  const memoryId = target.memoryId;
  if (!memoryId) {
    // No row to archive — still mark the deletion event seen so a retry returns
    // 'duplicate'. There is nothing to roll back here, so a handle of its own
    // is fine for this branch.
    markSlackEventSeen(ctx.hippoRoot, input.eventId, null);
    return { status: 'not_found', memoryId: null };
  }
  archiveRaw(
    { ...ctx, store: undefined }, // this function answers at once and its event reads go by root, so the archive runs on hippo.db too
    memoryId,
    `source_deleted:slack:${input.teamId}:${input.channelId}:${input.deletedTs}`,
    { event: { connector: 'slack', eventId: input.eventId } },
  );
  return { status: 'archived', memoryId };
}
