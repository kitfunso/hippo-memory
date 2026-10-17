// hippo.db's half of the KeyWrites store group.
import { ConflictError, NotFoundError } from '../core/api-errors.js';
import { appendAuditEvent } from './audit.js';
import { grantScope, insertApiKey, listLiveOwnedKeyIds, revokeApiKey, ungrantScope } from './auth.js';
import { withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import type { KeyMint, SelfKeyMint } from './port.js';
import { selectApiKeyOwner } from './tenant-lookup.js';
import type { AppendAuditOpts } from './port/types.js';

/** The auth_create row a mint writes; the plaintext never reaches it. */
function createAuditOf({ key, actor, metadata }: KeyMint): AppendAuditOpts {
  return { tenantId: key.tenantId, actor, op: 'auth_create', targetId: key.keyId, metadata };
}

export function createKeyAt(db: DatabaseSyncLike, mint: KeyMint): void {
  withWriteScope(db, 'create_api_key', () => {
    insertApiKey(db, mint.key);
    appendAuditEvent(db, createAuditOf(mint));
  });
}

/** IMMEDIATE takes the write lock before the count, so two mints for one owner cannot both see room under the cap. */
export function createSelfKeyAt(db: DatabaseSyncLike, mint: SelfKeyMint): string[] {
  const { key, actor, perSubject } = mint;
  return withWriteScope(db, 'create_self_api_key', () => {
    const live = listLiveOwnedKeyIds(db, key.tenantId, key.ownerSubject, Date.parse(key.createdAt));
    const replaced = live.slice(0, Math.max(0, live.length - perSubject + 1));
    insertApiKey(db, key);
    for (const keyId of replaced) {
      revokeApiKey(db, keyId, key.createdAt);
      appendAuditEvent(db, {
        tenantId: key.tenantId,
        actor,
        op: 'auth_revoke',
        targetId: keyId,
        metadata: { replacedBy: key.keyId },
      });
    }
    appendAuditEvent(db, createAuditOf(mint));
    return replaced;
  });
}

/** One grant or ungrant on a key of `tenantId`, and the actor of its audit row; the api has already refused an open or
 * personal scope. */
export interface ScopeGrantChange {
  readonly tenantId: string;
  readonly keyId: string;
  readonly scope: string;
  readonly op: 'auth_grant' | 'auth_ungrant';
  readonly actor: string;
}

/** The change and its audit row commit together, so a failed audit write leaves the grants as they were. */
export function changeScopeGrantAt(
  db: DatabaseSyncLike,
  { tenantId, keyId, scope, op, actor }: ScopeGrantChange,
): void {
  withWriteScope(db, 'change_scope_grant', () => {
    // Under the write lock, not in the api: a revoke landing between a check there and this grant would leave a
    // grant on a dead key.
    const row = selectApiKeyOwner(db, keyId);
    if (!row || row.tenantId !== tenantId) {
      throw new NotFoundError(`Unknown key_id: ${keyId}`);
    }
    if (op === 'auth_grant' && row.revokedAt) {
      throw new ConflictError(`${keyId} is revoked; a grant on it would never apply`);
    }
    if (op === 'auth_grant') grantScope(db, keyId, scope);
    else ungrantScope(db, keyId, scope);
    appendAuditEvent(db, { tenantId, actor, op, targetId: keyId, metadata: { scope } });
  });
}
