import { archiveRaw, type Context } from '../../api.js';
import { openHippoDb, closeHippoDb } from '../../db.js';
import { markEventSeen, hasSeenEvent } from './idempotency.js';

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
 * Handle Slack `message_deleted`. v0.39 commit 3 closes the prior race where
 * the archive committed but `markEventSeen` ran on a second db handle — a
 * crash between them left the deletion event un-acked, and the next retry
 * hit a now-archived row and returned `not_found` instead of `duplicate`.
 *
 * Fix: pass `afterArchive` to `archiveRaw`, which runs inside the same
 * SAVEPOINT as the archive itself. The slack_event_log row commits with the
 * archive or not at all.
 */
export function handleMessageDeleted(ctx: Context, input: DeletionInput): DeletionResult {
  const db = openHippoDb(ctx.hippoRoot);
  let memoryId: string | null = null;
  try {
    if (hasSeenEvent(db, input.eventId)) {
      return { status: 'duplicate', memoryId: null };
    }
    const ref = `slack://${input.teamId}/${input.channelId}/${input.deletedTs}`;
    // Tenant scope is load-bearing: without `tenant_id = ?` a deletion event
    // from tenant A could archive tenant B's raw row sharing the same
    // artifact_ref. The `kind = 'raw'` filter prevents accidentally targeting
    // distilled rows.
    const row = db
      .prepare(`SELECT id FROM memories WHERE artifact_ref = ? AND tenant_id = ? AND kind = 'raw'`)
      .get(ref, ctx.tenantId) as { id?: string } | undefined;
    memoryId = row?.id ?? null;
  } finally {
    closeHippoDb(db);
  }
  if (!memoryId) {
    // No row to archive — still mark the deletion event seen so a retry returns
    // 'duplicate'. There is nothing to roll back here, so the second-handle
    // pattern is fine for this branch.
    const db2 = openHippoDb(ctx.hippoRoot);
    try { markEventSeen(db2, input.eventId, null); }
    finally { closeHippoDb(db2); }
    return { status: 'not_found', memoryId: null };
  }
  // Archive + event-log mark commit together via afterArchive. The hook
  // receives the same db handle the archive is using, so the INSERT lives
  // inside the SAVEPOINT.
  archiveRaw(
    ctx,
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
