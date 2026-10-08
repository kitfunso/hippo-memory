// hippo.db's half of the KeyWrites store group.
import { appendAuditEvent, type AppendAuditOpts } from '../audit.js';
import { insertApiKey, listLiveOwnedKeyIds, revokeApiKey } from '../auth.js';
import { withWriteScope, type DatabaseSyncLike } from '../db.js';
import type { KeyMint, SelfKeyMint } from './port.js';

/** The auth_create row a mint writes; the plaintext never reaches it. */
export function createAuditOf({ key, actor, metadata }: KeyMint): AppendAuditOpts {
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
      appendAuditEvent(db, { tenantId: key.tenantId, actor, op: 'auth_revoke', targetId: keyId, metadata: { replacedBy: key.keyId } });
    }
    appendAuditEvent(db, createAuditOf(mint));
    return replaced;
  });
}
