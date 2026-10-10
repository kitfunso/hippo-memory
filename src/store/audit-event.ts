import { openHippoDb } from '../db/index.js';
import { resolveTenantId } from './tenant.js';
import { type AuditOp, appendAuditEvent, reportAuditWriteFailure } from './audit.js';
import { RejectedValueError } from './rejection.js';
import type { JsonValue } from '../util/json.js';

export interface AuditOptions {
  readonly targetId?: string;
  readonly metadata?: Record<string, JsonValue>;
  readonly actor?: string;
  readonly tenantId?: string;
}

/** Emit an audit event for a mutation. Never throws: the SQLite store stays the source of truth,
 * and a failed audit write shows up as missing rows. */
export function audit(db: ReturnType<typeof openHippoDb>, op: AuditOp, options: AuditOptions = {}): void {
  const { targetId, metadata, actor = 'cli', tenantId } = options;
  try {
    appendAuditEvent(db, {
      tenantId: tenantId ?? resolveTenantId({}),
      actor,
      op,
      targetId,
      metadata,
    });
  } catch (error) {
    // The mutation has already succeeded; a broken audit table must not undo it.
    reportAuditWriteFailure(op, String(error), targetId);
  }
}

/** Refusal audit for the rejected-value guard, written by the transaction owner after rollback so the caller's own rollback cannot claw it back.
 * Best-effort like `audit()`: never throws. */
export function auditRejectionRefusal(
  db: ReturnType<typeof openHippoDb>,
  err: RejectedValueError,
  actor: string,
): void {
  audit(db, 'reject_refusal', { targetId: err.entryId, metadata: { digest: err.digest, reason: err.reason }, actor, tenantId: err.tenantId });
}
