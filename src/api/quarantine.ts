// Quarantine review: list, approve and reject held memories.

import { ConflictError, ForbiddenError, NotFoundError } from '../core/api-errors.js';
import { requireGroup, storeFor } from '../store/index.js';
import type { QuarantineRefusal } from '../store/port.js';
import type { QuarantineStatus } from '../store/quarantine.js';
import type { KeysetPosition } from '../util/keyset.js';
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
export async function quarantineList(
  ctx: Context,
  opts: { status?: QuarantineStatus | 'all'; limit?: number; after?: KeysetPosition } = {},
): Promise<QuarantineListItem[]> {
  const rows = await requireGroup(storeFor(ctx), 'quarantine')
    .listQuarantined(ctx.tenantId, { status: opts.status ?? 'pending', limit: opts.limit, after: opts.after });
  return rows.map((row) => ({
    id: row.memoryId,
    originalScope: row.originalScope,
    reason: row.reason,
    status: row.status,
    quarantinedAt: row.quarantinedAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    contentPreview: (row.content ?? '').slice(0, QUARANTINE_PREVIEW_CHARS),
  }));
}

function refusalError(id: string, refusal: QuarantineRefusal): Error {
  if (refusal.outcome === 'not_quarantined') return new NotFoundError(`not quarantined: ${id}`);
  return new ConflictError(`${id} is already ${refusal.status}`);
}

/** Release a quarantined memory to its original scope. Admin only; the scope guard refuses a row moved since (mirrors restoreDormant). */
export async function quarantineApprove(ctx: Context, id: string): Promise<void> {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can approve a quarantined memory');
  }
  const result = await requireGroup(storeFor(ctx), 'quarantine').approveQuarantined(ctx.tenantId, id, ctx.actor.subject);
  if (result.outcome === 'approved') return;
  if (result.outcome === 'scope_moved') throw new ConflictError(`memory ${id} scope changed since quarantine; refusing to approve`);
  throw refusalError(id, result);
}

/** Keep a quarantined memory hidden for good. Admin only; the raw row is untouched (append-only). */
export async function quarantineReject(ctx: Context, id: string): Promise<void> {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can reject a quarantined memory');
  }
  const result = await requireGroup(storeFor(ctx), 'quarantine').rejectQuarantined(ctx.tenantId, id, ctx.actor.subject);
  if (result.outcome !== 'rejected') throw refusalError(id, result);
}
