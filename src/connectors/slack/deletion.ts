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
    const db2 = openHippoDb(ctx.hippoRoot);
    try { markEventSeen(db2, input.eventId, null); }
    finally { closeHippoDb(db2); }
    return { status: 'not_found', memoryId: null };
  }
  // api.archiveRaw now handles legacy mirror cleanup centrally so every caller
  // (CLI, REST route, MCP tool, this connector) gets the GDPR-correct archive.
  archiveRaw(ctx, memoryId, `source_deleted:slack:${input.teamId}:${input.channelId}:${input.deletedTs}`);
  const db3 = openHippoDb(ctx.hippoRoot);
  try { markEventSeen(db3, input.eventId, memoryId); }
  finally { closeHippoDb(db3); }
  return { status: 'archived', memoryId };
}
