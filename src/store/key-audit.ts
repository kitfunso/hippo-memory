// hippo.db's half of the KeyAudit store group.
import { NotFoundError } from '../api-errors.js';
import { appendAuditEvent } from '../audit.js';
import { revokeApiKey } from '../auth.js';
import { withWriteScope, type DatabaseSyncLike } from '../db.js';
import type { KeyRevoke } from './port.js';
import { selectApiKeyOwner } from './tenant-lookup.js';

/** The revoke and its audit row commit together, so a failed audit write leaves the key live and the caller sees the error. */
export function revokeKeyAt(db: DatabaseSyncLike, revoke: KeyRevoke): string {
  return withWriteScope(db, 'revoke_api_key', () => {
    const row = selectApiKeyOwner(db, revoke.keyId);
    if (!row || row.tenantId !== revoke.tenantId) throw new NotFoundError(`Unknown key_id: ${revoke.keyId}`);
    if (row.revokedAt) return row.revokedAt;
    revokeApiKey(db, revoke.keyId, revoke.at);
    appendAuditEvent(db, { tenantId: row.tenantId, actor: revoke.actor, op: 'auth_revoke', targetId: revoke.keyId });
    return revoke.at;
  });
}

export function auditHighIdAt(db: DatabaseSyncLike): number {
  // SAFETY: the SELECT names one column, seq; `.get` returns undefined before audit_log's first row.
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'").get() as { seq: number } | undefined;
  return row?.seq ?? 0;
}
