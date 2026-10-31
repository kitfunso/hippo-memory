// Audit log queries, which every store answers.

import type { KeysetPosition } from '../../base/util/keyset.js';
import type { Context } from '../types.js';
import type { AuditEvent } from '../../base/ports/store/types.js';
import type { AuditOp } from '../../base/records/audit-ops.js';

export interface AuditListOptions {
  op?: AuditOp;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
  /** Resume after this row: the (ts, id) position the previous page ended on. */
  after?: KeysetPosition;
}

/** Read audit events scoped to `ctx.tenantId` on the store the request runs on. Read-only, no
 * audit emit. */
export async function auditList(ctx: Context, opts: AuditListOptions): Promise<AuditEvent[]> {
  return ctx.store.auditLog.listAuditEvents({
    tenantId: ctx.tenantId,
    op: opts.op,
    since: opts.since,
    limit: opts.limit,
    after: opts.after,
  });
}
