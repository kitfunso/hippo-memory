import { type Context } from '../../api.js';
import { requireGroup, storeFor } from '../../store-port.js';

export interface DeletionInput {
  /** artifact_ref of the comment, e.g.,
   *  'github://acme/repo/issue/42/comment/123' or
   *  'github://acme/repo/pull/7/review_comment/456'. */
  artifactRef: string;
  /** Source idempotency key for this delete event (sha256 of artifact_ref + ':' + updated_at). */
  idempotencyKey: string;
  /** X-GitHub-Delivery header for audit log. */
  deliveryId: string;
  /** X-GitHub-Event header value: 'issue_comment' or 'pull_request_review_comment'. */
  eventName: string;
}

export type DeletionStatus = 'archived' | 'archive_skipped_not_found' | 'duplicate';

export interface DeletionResult {
  status: DeletionStatus;
  archivedCount: number;
}

/**
 * Handle GitHub `issue_comment.deleted` and `pull_request_review_comment.deleted`.
 *
 * Filter by tenant_id + kind='raw'. Multi-row archive:
 * GitHub edits keep the same artifact_ref, so multiple active raw rows can
 * match a single deletion event. Archive ALL of them.
 *
 * The store runs ALL archives + the idempotency mark as one write: a per-row
 * failure rolls back the whole batch, idempotency included, so a retry
 * re-attempts cleanly instead of leaving searchable survivors.
 *
 * Tenant scope and kind='raw' filtering are load-bearing: without them a
 * deletion event from tenant A could archive tenant B's row sharing the same
 * artifact_ref, or accidentally target a distilled row.
 */
export async function handleCommentDeleted(ctx: Context, input: DeletionInput): Promise<DeletionResult> {
  const { artifactRef, idempotencyKey, deliveryId, eventName } = input;
  const done = await requireGroup(storeFor(ctx), 'connectorEvents').archiveDeletedArtifact({
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    artifactRef,
    reason: `source_deleted:github:${eventName}:${deliveryId}`,
    event: { connector: 'github', idempotencyKey, deliveryId, eventName },
  });
  if (done.duplicate) return { status: 'duplicate', archivedCount: 0 };
  if (done.archived === 0) return { status: 'archive_skipped_not_found', archivedCount: 0 };
  return { status: 'archived', archivedCount: done.archived };
}
