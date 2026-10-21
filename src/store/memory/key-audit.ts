// The in-memory KeyAudit group: key revokes.
import { NotFoundError } from '../../base/errors/api-errors.js';
import type { KeyAudit, KeyRevoke } from '../port/keys.js';
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

export function memoryKeyAudit(t: MemoryTables): KeyAudit {
  return {
    revokeApiKey: async (revoke) => revokeIn(t, revoke),
  };
}
