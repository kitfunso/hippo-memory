// Audit log queries, and the removal of the memories a quality audit marks as errors.

import type { AuditEvent, AuditIssue, AuditOp } from '../store/audit.js';
import { deleteEntry } from '../store/delete-and-batch.js';
import { requireGroup, storeFor } from '../store/index.js';
import type { KeysetPosition } from '../util/keyset.js';
import type { Context } from './types.js';

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

/** The pass that removes audit errors; it leads the reason on each forget row. */
export type AuditPass = 'audit --fix' | 'sleep-audit';

/** Delete the memories an audit marked as errors, each with its own forget row, and answer the ids that went: a pinned or raw row stays. */
export function removeAuditErrors(ctx: Context, pass: AuditPass, issues: readonly AuditIssue[]): string[] {
  return issues
    .filter((issue) => issue.severity === 'error')
    .filter((issue) => deleteEntry(ctx.hippoRoot, issue.memoryId, { actor: ctx.actor.subject, reason: `${pass}: ${issue.reason}`, automatic: true }))
    .map((issue) => issue.memoryId);
}
