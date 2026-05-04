import { archiveRaw, type Context } from '../../api.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import { hasSeenKey, markKeySeen } from './idempotency.js';

export interface DeletionInput {
  /** artifact_ref of the comment, e.g.,
   *  'github://acme/repo/issue/42/comment/123' or
   *  'github://acme/repo/pull/7/review_comment/456'. */
  artifactRef: string;
  /** Source idempotency key for this delete event (sha256 of eventName+body). */
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
 * Codex P0 #5: filter by tenant_id + kind='raw'. Multi-row archive: GitHub edits
 * keep the same artifact_ref, so multiple active raw rows can match a single
 * deletion event (each edit produces a fresh raw memory id sharing the same
 * artifact_ref). Archive ALL of them, not just the most recent.
 *
 * Crash-safety: the afterArchive hook on archiveRaw runs inside the SAVEPOINT,
 * so the idempotency mark commits with the FIRST archive — a crash mid-archive
 * cannot leave the deletion event un-acked. A retry sees the key as 'seen' and
 * returns 'duplicate' instead of attempting a partial re-archive.
 *
 * Tenant scope is load-bearing: without `tenant_id = ?` a deletion event from
 * tenant A could archive tenant B's raw row sharing the same artifact_ref. The
 * `kind = 'raw'` filter prevents accidentally targeting distilled rows that
 * may share artifact_ref via downstream extraction.
 */
export function handleCommentDeleted(ctx: Context, input: DeletionInput): DeletionResult {
  // Fast-path duplicate check + look up all matching raw rows.
  const dbCheck = openHippoDb(ctx.hippoRoot);
  let memoryIds: string[] = [];
  try {
    if (hasSeenKey(dbCheck, input.idempotencyKey)) {
      return { status: 'duplicate', archivedCount: 0 };
    }
    const rows = dbCheck
      .prepare(
        `SELECT id FROM memories WHERE artifact_ref = ? AND tenant_id = ? AND kind = 'raw'`,
      )
      .all(input.artifactRef, ctx.tenantId) as Array<{ id: string }>;
    memoryIds = rows.map((r) => r.id);
  } finally {
    closeHippoDb(dbCheck);
  }

  if (memoryIds.length === 0) {
    // Nothing to archive — but still mark idempotency so a retry returns 'duplicate'.
    // No row to roll back, so the second-handle pattern is safe here.
    const dbMark = openHippoDb(ctx.hippoRoot);
    try {
      markKeySeen(dbMark, {
        idempotencyKey: input.idempotencyKey,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        memoryId: null,
      });
    } finally {
      closeHippoDb(dbMark);
    }
    return { status: 'archive_skipped_not_found', archivedCount: 0 };
  }

  // Archive each matching row. Mark idempotency on the first archive's
  // afterArchive hook so the mark lands inside the same SAVEPOINT as the first
  // archive (crash-safe). markKeySeen is INSERT OR IGNORE so subsequent calls
  // are no-ops, but we only need the first one to commit-or-rollback with the
  // first archive — that's enough to keep the source-of-truth lock-step.
  let firstMarked = false;
  for (const id of memoryIds) {
    archiveRaw(
      ctx,
      id,
      `source_deleted:github:${input.eventName}:${input.deliveryId}`,
      {
        afterArchive: (sameDb, archivedId) => {
          if (!firstMarked) {
            markKeySeen(sameDb, {
              idempotencyKey: input.idempotencyKey,
              deliveryId: input.deliveryId,
              eventName: input.eventName,
              memoryId: archivedId,
            });
            firstMarked = true;
          }
        },
      },
    );
  }
  return { status: 'archived', archivedCount: memoryIds.length };
}
