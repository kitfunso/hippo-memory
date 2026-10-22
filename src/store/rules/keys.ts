// A key write's checks, once for both adapters: an unknown key and another tenant's key fail alike, so a caller learns
// nothing about keys it does not own, and a grant on a revoked key is refused since it would never apply.
import { ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import type { ScopeGrantChange } from '../port/keys.js';

/** `key` when the tenant owns it; NotFoundError otherwise. */
export function ownedKey<K extends { readonly tenantId: string }>(key: K | undefined, tenantId: string, keyId: string) {
  if (!key || key.tenantId !== tenantId) throw new NotFoundError(`Unknown key_id: ${keyId}`);
  return key;
}

export function assertGrantable({ op, keyId }: Pick<ScopeGrantChange, 'op' | 'keyId'>, revokedAt: string | null): void {
  if (op === 'auth_grant' && revokedAt) throw new ConflictError(`${keyId} is revoked; a grant on it would never apply`);
}
