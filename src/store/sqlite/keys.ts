// hippo.db's key groups: KeyWrites, KeyGrants and KeyAudit.
import { assertGrantable, ownedKey } from '../rules/keys.js';
import { appendAuditEvents } from './audit.js';
import { grantScope, insertApiKey, listApiKeyRows, listLiveOwnedKeyIds, revokeApiKey, ungrantScope } from './auth.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import type { KeyAudit, KeyGrants, KeyMint, KeyRevoke, KeyWrites, SelfKeyMint } from '../port.js';
import type { OnHandle } from './open.js';
import { bound, type Bodies } from './bound.js';
import { selectApiKeyOwner } from './tenant-lookup.js';
import type { AppendAuditOpts } from '../port/types.js';
import type { ScopeGrantChange } from '../port/keys.js';

/** The auth_create row a mint writes; the plaintext never reaches it. */
function createAuditOf({ key, actor, metadata }: KeyMint): AppendAuditOpts {
  return { tenantId: key.tenantId, actor, op: 'auth_create', targetId: key.keyId, metadata };
}

function createKey(db: DatabaseSyncLike, mint: KeyMint): void {
  withWriteScope(db, 'create_api_key', () => {
    insertApiKey(db, mint.key);
    appendAuditEvents(db, [createAuditOf(mint)]);
  });
}

/** IMMEDIATE takes the write lock before the count, so two mints for one owner cannot both see room under the cap. */
function createSelfKey(db: DatabaseSyncLike, mint: SelfKeyMint): string[] {
  const { key, actor, perSubject } = mint;
  return withWriteScope(db, 'create_self_api_key', () => {
    const live = listLiveOwnedKeyIds(db, key.tenantId, key.ownerSubject, Date.parse(key.createdAt));
    const replaced = live.slice(0, Math.max(0, live.length - perSubject + 1));
    insertApiKey(db, key);
    for (const keyId of replaced) {
      revokeApiKey(db, keyId, key.createdAt);
      appendAuditEvents(db, [
        {
          tenantId: key.tenantId,
          actor,
          op: 'auth_revoke',
          targetId: keyId,
          metadata: { replacedBy: key.keyId },
        },
      ]);
    }
    appendAuditEvents(db, [createAuditOf(mint)]);
    return replaced;
  });
}

/** The change and its audit row commit together, so a failed audit write leaves the grants as they were. */
function changeScopeGrant(db: DatabaseSyncLike, { tenantId, keyId, scope, op, actor }: ScopeGrantChange): void {
  withWriteScope(db, 'change_scope_grant', () => {
    // Under the write lock, not in the api: a revoke landing between a check there and this grant would leave a grant
    // on a dead key.
    const row = ownedKey(selectApiKeyOwner(db, keyId), tenantId, keyId);
    assertGrantable({ op, keyId }, row.revokedAt);
    if (op === 'auth_grant') grantScope(db, keyId, scope);
    else ungrantScope(db, keyId, scope);
    appendAuditEvents(db, [{ tenantId, actor, op, targetId: keyId, metadata: { scope } }]);
  });
}

/** The revoke and its audit row commit together, so a failed audit write leaves the key live and the caller sees the
 * error. */
function revokeKey(db: DatabaseSyncLike, revoke: KeyRevoke): string {
  return withWriteScope(db, 'revoke_api_key', () => {
    const row = ownedKey(selectApiKeyOwner(db, revoke.keyId), revoke.tenantId, revoke.keyId);
    if (row.revokedAt) return row.revokedAt;
    revokeApiKey(db, revoke.keyId, revoke.at);
    appendAuditEvents(db, [{ tenantId: row.tenantId, actor: revoke.actor, op: 'auth_revoke', targetId: revoke.keyId }]);
    return revoke.at;
  });
}

const keyWritesBodies: Bodies<KeyWrites> = {
  createApiKey: createKey,
  createSelfApiKey: createSelfKey,
  listApiKeys: listApiKeyRows,
};

const keyAuditBodies: Bodies<KeyAudit> = {
  revokeApiKey: revokeKey,
};

export function sqliteKeyWrites(on: OnHandle): KeyWrites {
  return bound(on, keyWritesBodies);
}

export function sqliteKeyGrants(on: OnHandle): KeyGrants {
  return bound<KeyGrants>(on, { changeScopeGrant: changeScopeGrant });
}

export function sqliteKeyAudit(on: OnHandle): KeyAudit {
  return bound(on, keyAuditBodies);
}
