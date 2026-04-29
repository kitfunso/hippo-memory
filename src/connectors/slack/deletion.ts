import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
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
  archiveRaw(ctx, memoryId, `source_deleted:slack:${input.teamId}:${input.channelId}:${input.deletedTs}`);
  // archiveRawMemory deletes the memories row but does not remove the legacy
  // markdown mirror in <root>/{buffer,episodic,semantic}/<id>.md. If we leave
  // the mirror in place, a subsequent initStore() on an empty memories table
  // would re-import the row via bootstrapLegacyStore — silently undoing the
  // archive. Drop the mirror so the GDPR-style deletion is complete.
  for (const layer of ['buffer', 'episodic', 'semantic']) {
    const file = join(ctx.hippoRoot, layer, `${memoryId}.md`);
    if (existsSync(file)) unlinkSync(file);
  }
  const db3 = openHippoDb(ctx.hippoRoot);
  try { markEventSeen(db3, input.eventId, memoryId); }
  finally { closeHippoDb(db3); }
  return { status: 'archived', memoryId };
}
