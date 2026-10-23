// The in-memory KeyAudit group: key revokes.
import type { KeyAudit, KeyRevoke } from '../port/keys.js';
import { ownedKey } from '../rules/keys.js';
import { appendAudit } from './rows.js';
import type { MemoryTables } from './tables.js';

function revokeIn(t: MemoryTables, { tenantId, keyId, actor, at }: KeyRevoke): string {
  const key = ownedKey(t.keys.get(keyId), tenantId, keyId);
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
