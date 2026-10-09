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

/**
 * Emit an audit event for a mutation against `db`. Wrapped so a broken audit
 * log can never crash the surrounding mutation — the SQLite store is still the
 * source of truth and audit failures are diagnosable from the missing rows.
 */
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

/**
 * Refusal audit for the rejected-value guard. Written by the
 * transaction OWNER post-rollback — writeEntry's catch (no outer tx exists
 * there, so this lands in a fresh implicit transaction) and commitSupersede's
 * catch (after its own ROLLBACK) — never inside a scope the caller's own
 * rollback could claw back. Best-effort `audit()` semantics: never throws.
 */
export function auditRejectionRefusal(
  db: ReturnType<typeof openHippoDb>,
  err: RejectedValueError,
  actor: string,
): void {
  audit(db, 'reject_refusal', { targetId: err.entryId, metadata: { digest: err.digest, reason: err.reason }, actor, tenantId: err.tenantId });
}
