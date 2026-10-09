// Audit log queries.

import type { AuditEvent, AuditOp, QueryAuditOpts } from '../audit.js';
import { requireGroup, storeFor } from '../store-port.js';
import { sqliteSyncStore } from '../store/sqlite/store.js';
import type { KeysetPosition } from '../keyset.js';
import type { Context } from './types.js';

// ---------------------------------------------------------------------------
// audit: list
// ---------------------------------------------------------------------------

export interface AuditListOpts {
  op?: AuditOp;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
  /** Resume after this row: the (ts, id) position the previous page ended on. */
  after?: KeysetPosition;
}

function auditQuery(ctx: Context, opts: AuditListOpts): QueryAuditOpts {
  return { tenantId: ctx.tenantId, op: opts.op, since: opts.since, limit: opts.limit, after: opts.after };
}

/**
 * Read audit events scoped to `ctx.tenantId`. Read-only, no audit emit (matches
 * cmdAuditList, which does not record a 'recall'-style read event).
 */
export function auditList(ctx: Context, opts: AuditListOpts): AuditEvent[] {
  return sqliteSyncStore(ctx.hippoRoot).auditLog.listAuditEvents(auditQuery(ctx, opts));
}

/** `auditList` on the store the request runs on; a store without the auditLog group rejects with StoreNotPortedError. */
export async function auditListServed(ctx: Context, opts: AuditListOpts): Promise<AuditEvent[]> {
  return requireGroup(storeFor(ctx), 'auditLog').listAuditEvents(auditQuery(ctx, opts));
}
