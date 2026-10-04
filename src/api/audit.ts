// Audit log queries.

import { openHippoDb, closeHippoDb } from '../db.js';
import { queryAuditEvents, type AuditEvent, type AuditOp } from '../audit.js';
import type { Context } from './types.js';

// ---------------------------------------------------------------------------
// audit: list
// ---------------------------------------------------------------------------

export interface AuditListOpts {
  op?: AuditOp;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
}

/**
 * Read audit events scoped to `ctx.tenantId`. Read-only — no audit emit (matches
 * A5: cmdAuditList does not record a 'recall'-style read event).
 */
export function auditList(ctx: Context, opts: AuditListOpts): AuditEvent[] {
  const db = openHippoDb(ctx.hippoRoot);
  try {
    return queryAuditEvents(db, {
      tenantId: ctx.tenantId,
      op: opts.op,
      since: opts.since,
      limit: opts.limit,
    });
  } finally {
    closeHippoDb(db);
  }
}
