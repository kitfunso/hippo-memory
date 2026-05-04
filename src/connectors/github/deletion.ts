import { type Context } from '../../api.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import { archiveRawMemory } from '../../raw-archive.js';
import { hasSeenKey, markKeySeen } from './idempotency.js';

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
 * Codex round 1 P0 #5: filter by tenant_id + kind='raw'. Multi-row archive:
 * GitHub edits keep the same artifact_ref, so multiple active raw rows can
 * match a single deletion event. Archive ALL of them.
 *
 * Claude round 2 P0 #2 (v1.3.1 hotfix): the v1.3.0 implementation called
 * archiveRaw N times in a loop, each opening its own DB handle and SAVEPOINT.
 * The first archive's afterArchive committed the idempotency mark. If archive
 * 2..N threw, idempotency was already committed and retry returned 'duplicate'
 * with archivedCount=0 — survivors stayed searchable, leaking private bodies.
 *
 * v1.3.1 fix: ONE shared DB handle wrapping ALL archives + the idempotency
 * mark in a single outer SAVEPOINT. Any per-row failure rolls back the entire
 * batch (including idempotency), so retry re-attempts cleanly. archiveRawMemory
 * (the lower-level function from raw-archive.js) runs its own inner SAVEPOINT
 * which nests safely inside the outer one.
 *
 * Tenant scope and kind='raw' filtering are load-bearing: without them a
 * deletion event from tenant A could archive tenant B's row sharing the same
 * artifact_ref, or accidentally target a distilled row.
 */
export function handleCommentDeleted(ctx: Context, input: DeletionInput): DeletionResult {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    if (hasSeenKey(db, input.idempotencyKey)) {
      return { status: 'duplicate', archivedCount: 0 };
    }

    const rows = db
      .prepare(
        `SELECT id FROM memories WHERE artifact_ref = ? AND tenant_id = ? AND kind = 'raw'`,
      )
      .all(input.artifactRef, ctx.tenantId) as Array<{ id: string }>;
    const memoryIds = rows.map((r) => r.id);

    if (memoryIds.length === 0) {
      // Nothing to archive — still mark idempotency so a retry returns 'duplicate'.
      // Independent INSERT, no rollback needed.
      markKeySeen(db, {
        idempotencyKey: input.idempotencyKey,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        memoryId: null,
      });
      return { status: 'archive_skipped_not_found', archivedCount: 0 };
    }

    // Outer SAVEPOINT wrapping all archives + the idempotency mark. Any throw
    // rolls back the whole batch so retry sees neither archive nor mark — and
    // re-attempts the full set.
    db.exec('SAVEPOINT github_delete_all');
    try {
      for (const id of memoryIds) {
        archiveRawMemory(db, id, {
          reason: `source_deleted:github:${input.eventName}:${input.deliveryId}`,
          who: ctx.actor || 'connector:github',
        });
      }
      markKeySeen(db, {
        idempotencyKey: input.idempotencyKey,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        memoryId: memoryIds[0]!,
      });
      db.exec('RELEASE SAVEPOINT github_delete_all');
    } catch (e) {
      try {
        db.exec('ROLLBACK TO SAVEPOINT github_delete_all');
        db.exec('RELEASE SAVEPOINT github_delete_all');
      } catch {
        // Best effort. Surface the original error.
      }
      throw e;
    }
    return { status: 'archived', archivedCount: memoryIds.length };
  } finally {
    closeHippoDb(db);
  }
}
