import type { ConnectorContext } from '../ingest.js';
import { legacyGitHubRef } from './ref.js';

export interface DeletionInput {
  artifactRef: string;
  idempotencyKey: string;
  deliveryId: string;
  eventName: string;
  ownsBareRefs?: boolean;
}

export type DeletionStatus = 'archived' | 'archive_skipped_not_found' | 'duplicate';

export interface DeletionResult {
  status: DeletionStatus;
  archivedCount: number;
}

/** Handle `issue_comment.deleted` and `pull_request_review_comment.deleted`: archive ALL active
 * raw rows for the artifact_ref in one write. Tenant and kind='raw' filtering are load-bearing:
 * without them a deletion could archive another tenant's row or a distilled row. A GHES ref also
 * archives the github.com-form twin only when the operator says bare refs are this server's. */
export async function handleCommentDeleted(
  ctx: ConnectorContext,
  input: DeletionInput,
): Promise<DeletionResult> {
  const { artifactRef, idempotencyKey, deliveryId, eventName, ownsBareRefs } = input;
  const event = { connector: 'github', idempotencyKey, deliveryId, eventName } as const;
  const done = await ctx.store.connectorEvents.markEventSeen(event, {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    artifactRef,
    legacyArtifactRef: ownsBareRefs === true ? legacyGitHubRef(artifactRef) : undefined,
    reason: `source_deleted:github:${eventName}:${deliveryId}`,
  });
  if (done.duplicate) return { status: 'duplicate', archivedCount: 0 };
  if (done.archived === 0) return { status: 'archive_skipped_not_found', archivedCount: 0 };
  return { status: 'archived', archivedCount: done.archived };
}
