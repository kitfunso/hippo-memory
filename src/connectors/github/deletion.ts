import { type Context } from '../../api/index.js';
import { requireGroup, storeFor } from '../../store/index.js';

export interface DeletionInput {
  /** artifact_ref of the comment, e.g. 'github://acme/repo/issue/42/comment/123'
   *  or 'github://acme/repo/pull/7/review_comment/456'. */
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

/** Handle `issue_comment.deleted` and `pull_request_review_comment.deleted`: archive ALL active raw rows for the artifact_ref in one write.
 *  Tenant and kind='raw' filtering are load-bearing: without them a deletion could archive another tenant's row or a distilled row. */
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
