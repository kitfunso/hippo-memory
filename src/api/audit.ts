// Audit log queries.

import type { AuditEvent, AuditOp } from '../store/audit.js';
import { requireGroup, storeFor } from '../store/index.js';
import type { KeysetPosition } from '../util/keyset.js';
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

/** Read audit events scoped to `ctx.tenantId` on the store the request runs on. Read-only, no audit emit. */
export async function auditList(ctx: Context, opts: AuditListOpts): Promise<AuditEvent[]> {
  return requireGroup(storeFor(ctx), 'auditLog').listAuditEvents({
    tenantId: ctx.tenantId, op: opts.op, since: opts.since, limit: opts.limit, after: opts.after,
  });
}
