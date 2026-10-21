// The in-memory KeyAudit group: key revokes and the audit tail a key holder reads.
import { NotFoundError } from '../../base/errors/api-errors.js';
import { MAX_AUDIT_LIMIT } from '../../base/util/limits.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { KeyAudit, KeyRevoke, ListAuditAfterOpts } from '../port/key-audit.js';
import type { AuditEvent } from '../port/types.js';
import { appendAudit } from './rows.js';
import type { MemoryTables } from './tables.js';

function revokeIn(t: MemoryTables, { tenantId, keyId, actor, at }: KeyRevoke): string {
  const key = t.keys.get(keyId);
  if (!key || key.tenantId !== tenantId) throw new NotFoundError(`Unknown key_id: ${keyId}`);
  if (key.revokedAt) return key.revokedAt;
  appendAudit(t, [{ tenantId: key.tenantId, actor, op: 'auth_revoke', targetId: keyId }]);
  t.keys.set(keyId, { ...key, revokedAt: at });
  return at;
}

/** listAuditEventsAfter's checks and clamp, which every store owes its callers. */
function auditAfterIn(t: MemoryTables, opts: ListAuditAfterOpts): AuditEvent[] {
  if (!Number.isInteger(opts.afterId) || opts.afterId < 0) {
    throw new RangeError('afterId must be a non-negative integer');
  }
  if (opts.limit !== undefined && !Number.isInteger(opts.limit)) throw new RangeError('limit must be an integer');
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, MAX_AUDIT_LIMIT));
  const rows = t.audit.filter(
    (e) => e.id > opts.afterId && (opts.tenantId === ALL_TENANTS || e.tenantId === opts.tenantId),
  );
  return structuredClone(rows.slice(0, limit));
}

export function memoryKeyAudit(t: MemoryTables): KeyAudit {
  return {
    revokeApiKey: async (revoke) => revokeIn(t, revoke),
    auditEventsAfter: async (opts) => auditAfterIn(t, opts),
    auditHighId: async () => t.seq.get('audit_log') ?? 0,
  };
}
