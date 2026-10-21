// The in-memory KeyGrants group: the CLI's auth grant and ungrant.
import { ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import type { KeyGrants, ScopeGrantChange } from '../port/key-grants.js';
import { byBytes } from '../rules/order.js';
import { appendAudit } from './rows.js';
import type { MemoryTables } from './tables.js';

function changeGrantIn(t: MemoryTables, { tenantId, keyId, scope, op, actor }: ScopeGrantChange): void {
  const key = t.keys.get(keyId);
  if (!key || key.tenantId !== tenantId) throw new NotFoundError(`Unknown key_id: ${keyId}`);
  if (op === 'auth_grant' && key.revokedAt) {
    throw new ConflictError(`${keyId} is revoked; a grant on it would never apply`);
  }
  const others = key.scopes.filter((s) => s !== scope);
  const scopes = op === 'auth_grant' ? [...others, scope].sort(byBytes) : others;
  appendAudit(t, [{ tenantId, actor, op, targetId: keyId, metadata: { scope } }]);
  t.keys.set(keyId, { ...key, scopes });
}

export function memoryKeyGrants(t: MemoryTables): KeyGrants {
  return { changeScopeGrant: async (change) => changeGrantIn(t, change) };
}
