import { archiveRaw, type Context } from '../../api.js';
import { markSlackEventSeen, slackDeletionTarget } from '../../store/connectors/slack.js';
import { markEventSeen } from './idempotency.js';

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

/**
 * Handle Slack `message_deleted`. `afterArchive` runs inside the archive's own
 * SAVEPOINT, so the slack_event_log row commits with the archive or not at all
 * and a crash cannot leave a retry hitting `not_found` instead of `duplicate`.
 */
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
  // Archive + event-log mark commit together via afterArchive. The hook
  // receives the same db handle the archive is using, so the INSERT lives
  // inside the SAVEPOINT.
  archiveRaw(
    { ...ctx, store: undefined }, // afterArchive runs on hippo.db's own handle, never through a store
    memoryId,
    `source_deleted:slack:${input.teamId}:${input.channelId}:${input.deletedTs}`,
    {
      afterArchive: (sameDb, archivedId) => {
        markEventSeen(sameDb, input.eventId, archivedId);
      },
    },
  );
  return { status: 'archived', memoryId };
}
