// hippo.db's KeyWrites group: every key write with its audit rows, and the key list.
import { appendAuditEvents } from './audit.js';
import {
  grantScope,
  insertApiKey,
  listApiKeyRows,
  listLiveOwnedKeyIds,
  revokeApiKey,
  ungrantScope,
} from './auth.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import type {
  KeyCalls,
  KeyChangeArgs,
  KeyMint,
  KeyRevoke,
  KeyWrites,
  ScopeGrantChange,
  SelfKeyMint,
} from '../../base/ports/store/keys.js';
import type { OnHandle } from './open.js';
import { bound, type Bodies } from './bound.js';
import { readApiKeyOwner } from './tenant-lookup.js';
import type { AppendAuditOptions } from '../../base/ports/store/types.js';
import { ConflictError, NotFoundError } from '../../base/errors/api-errors.js';

// A key write's checks: an unknown key and another tenant's key fail alike, so a caller learns
// nothing about keys it does not own, and a grant on a revoked key is refused since it would never
// apply.

/** `key` when the tenant owns it; NotFoundError otherwise. */
function ownedKey<K extends { readonly tenantId: string }>(
  key: K | undefined,
  tenantId: string,
  keyId: string,
) {
  if (!key || key.tenantId !== tenantId) throw new NotFoundError(`Unknown key_id: ${keyId}`);
  return key;
}

function assertGrantable(
  { op, keyId }: Pick<ScopeGrantChange, 'op' | 'keyId'>,
  revokedAt: string | null,
): void {
  if (op === 'auth_grant' && revokedAt)
    throw new ConflictError(`${keyId} is revoked; a grant on it would never apply`);
}

/** The auth_create row a mint writes; the plaintext never reaches it. */
function createAuditOf({ key, actor, metadata }: KeyMint): AppendAuditOptions {
  return { tenantId: key.tenantId, actor, op: 'auth_create', targetId: key.keyId, metadata };
}

function createKey(db: DatabaseSyncLike, mint: KeyMint): void {
  withWriteScope(db, 'create_api_key', () => {
    insertApiKey(db, mint.key);
    appendAuditEvents(db, [createAuditOf(mint)]);
  });
}

/** IMMEDIATE takes the write lock before the count, so two mints for one owner cannot both see
 * room under the cap. */
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

/** The change and its audit row commit together, so a failed audit write leaves the grants as
 * they were. */
function changeScopeGrant(
  db: DatabaseSyncLike,
  { tenantId, keyId, scope, op, actor }: ScopeGrantChange,
): void {
  withWriteScope(db, 'change_scope_grant', () => {
    // Under the write lock, not in the api: a revoke landing between a check there and this grant
    // would leave a grant on a dead key.
    const row = ownedKey(readApiKeyOwner(db, keyId), tenantId, keyId);
    assertGrantable({ op, keyId }, row.revokedAt);
    if (op === 'auth_grant') grantScope(db, keyId, scope);
    else ungrantScope(db, keyId, scope);
    appendAuditEvents(db, [{ tenantId, actor, op, targetId: keyId, metadata: { scope } }]);
  });
}

/** The revoke and its audit row commit together, so a failed audit write leaves the key live and
 * the caller sees the error. */
function revokeKey(db: DatabaseSyncLike, revoke: KeyRevoke): string {
  return withWriteScope(db, 'revoke_api_key', () => {
    const row = ownedKey(readApiKeyOwner(db, revoke.keyId), revoke.tenantId, revoke.keyId);
    if (row.revokedAt) return row.revokedAt;
    revokeApiKey(db, revoke.keyId, revoke.at);
    appendAuditEvents(db, [
      { tenantId: row.tenantId, actor: revoke.actor, op: 'auth_revoke', targetId: revoke.keyId },
    ]);
    return revoke.at;
  });
}

function changeKey(
  db: DatabaseSyncLike,
  ...[change, input]: KeyChangeArgs
): void | string[] | string {
  if (change === 'create') return createKey(db, input);
  if (change === 'create_self') return createSelfKey(db, input);
  if (change === 'revoke') return revokeKey(db, input);
  return changeScopeGrant(db, input);
}

const keyWritesBodies: Bodies<KeyCalls> = {
  changeApiKey: changeKey,
  listApiKeys: listApiKeyRows,
};

export function sqliteKeyWrites(on: OnHandle): KeyWrites {
  // SAFETY: changeKey answers each change with the value the port's overload for it names.
  return bound(on, keyWritesBodies) as KeyWrites;
}
