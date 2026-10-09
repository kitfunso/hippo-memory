// Quarantine review: list, approve and reject held memories.

import { openHippoDb, closeHippoDb, withWriteScope, type DatabaseSyncLike } from '../db.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../api-errors.js';
import { writeEntryMirrors } from '../store/entry-writes.js';
import { readEntry, selectEntriesByIds } from '../store/entry-reads.js';
import {
  quarantineScopeFor,
  getQuarantineRow,
  listQuarantineRows,
  approveQuarantineRow,
  rejectQuarantineRow,
  type QuarantineStatus,
} from '../quarantine.js';
import { log } from '../log.js';
import type { KeysetPosition } from '../keyset.js';
import { appendAuditEvent } from '../audit.js';
import type { Context } from './types.js';

// ---------------------------------------------------------------------------
// quarantine (CD5)
// ---------------------------------------------------------------------------

export interface QuarantineListItem {
  id: string;
  originalScope: string | null;
  reason: string;
  status: QuarantineStatus;
  quarantinedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  contentPreview: string;
}

const QUARANTINE_PREVIEW_CHARS = 200;

/** A tenant's quarantined memories, newest first. Default `status` is 'pending' (the review queue). */
export function quarantineList(
  ctx: Context,
  opts: { status?: QuarantineStatus | 'all'; limit?: number; after?: KeysetPosition } = {},
): QuarantineListItem[] {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    const rows = listQuarantineRows(db, ctx.tenantId, opts.status ?? 'pending', opts.limit, opts.after);
    const entries = selectEntriesByIds(db, rows.map((row) => row.memoryId), ctx.tenantId);
    return rows.map((row) => {
      const entry = entries.get(row.memoryId);
      return {
        id: row.memoryId,
        originalScope: row.originalScope,
        reason: row.reason,
        status: row.status,
        quarantinedAt: row.quarantinedAt,
        decidedAt: row.decidedAt,
        decidedBy: row.decidedBy,
        contentPreview: entry ? entry.content.slice(0, QUARANTINE_PREVIEW_CHARS) : '',
      };
    });
  } finally {
    closeHippoDb(db);
  }
}

function loadPendingQuarantineRow(db: DatabaseSyncLike, tenantId: string, id: string) {
  const row = getQuarantineRow(db, tenantId, id);
  if (!row) throw new NotFoundError(`not quarantined: ${id}`);
  if (row.status !== 'pending') throw new ConflictError(`${id} is already ${row.status}`);
  return row;
}

/** Release a quarantined memory to its original scope. Admin only; the scope guard refuses a row moved since (mirrors restoreDormant). */
export function quarantineApprove(ctx: Context, id: string): void {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can approve a quarantined memory');
  }
  const db = openHippoDb(ctx.hippoRoot);
  try {
    withWriteScope(db, 'quarantine_approve', () => {
      const row = loadPendingQuarantineRow(db, ctx.tenantId, id);
      const quarantineScope = quarantineScopeFor(row.originalScope);
      const updated = db
        .prepare(`UPDATE memories SET scope = ? WHERE id = ? AND tenant_id = ? AND scope = ?`)
        .run(row.originalScope, id, ctx.tenantId, quarantineScope);
      if (Number(updated.changes ?? 0) !== 1) {
        throw new ConflictError(`memory ${id} scope changed since quarantine; refusing to approve`);
      }
      approveQuarantineRow(db, ctx.tenantId, id, ctx.actor.subject);
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor.subject,
        op: 'quarantine_approve',
        targetId: id,
        metadata: { originalScope: row.originalScope },
      });
    });
  } finally {
    closeHippoDb(db);
  }
  // Post-commit, best-effort: a failed rewrite leaves the mirror showing the quarantine scope (fail-closed).
  try {
    const restored = readEntry(ctx.hippoRoot, id, ctx.tenantId);
    if (restored) writeEntryMirrors(ctx.hippoRoot, restored);
  } catch (err) {
    log.error(`quarantine: mirror rewrite failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Keep a quarantined memory hidden for good. Admin only; the raw row is untouched (append-only). */
export function quarantineReject(ctx: Context, id: string): void {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can reject a quarantined memory');
  }
  const db = openHippoDb(ctx.hippoRoot);
  try {
    withWriteScope(db, 'quarantine_reject', () => {
      loadPendingQuarantineRow(db, ctx.tenantId, id);
      rejectQuarantineRow(db, ctx.tenantId, id, ctx.actor.subject);
      appendAuditEvent(db, {
        tenantId: ctx.tenantId,
        actor: ctx.actor.subject,
        op: 'quarantine_reject',
        targetId: id,
        metadata: {},
      });
    });
  } finally {
    closeHippoDb(db);
  }
}
