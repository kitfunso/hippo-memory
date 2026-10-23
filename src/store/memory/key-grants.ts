// The in-memory KeyGrants group: the CLI's auth grant and ungrant.
import type { KeyGrants, ScopeGrantChange } from '../port/keys.js';
import { assertGrantable, ownedKey } from '../rules/keys.js';
import { byBytes } from '../rules/order.js';
import { appendAudit } from './rows.js';
import type { MemoryTables } from './tables.js';

function changeGrantIn(t: MemoryTables, { tenantId, keyId, scope, op, actor }: ScopeGrantChange): void {
  const key = ownedKey(t.keys.get(keyId), tenantId, keyId);
  assertGrantable({ op, keyId }, key.revokedAt);
  const others = key.scopes.filter((s) => s !== scope);
  const scopes = op === 'auth_grant' ? [...others, scope].sort(byBytes) : others;
  appendAudit(t, [{ tenantId, actor, op, targetId: keyId, metadata: { scope } }]);
  t.keys.set(keyId, { ...key, scopes });
}

export function memoryKeyGrants(t: MemoryTables): KeyGrants {
  return { changeScopeGrant: async (change) => changeGrantIn(t, change) };
}
