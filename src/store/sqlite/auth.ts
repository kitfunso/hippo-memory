import { scryptSync } from 'node:crypto';
import {
  DEFAULT_KEY_TTL_DAYS,
  isUsableKey,
  keyExpiryMs,
  mintApiKey,
  mintedKeyId,
  storedScrypt,
  verifiedKeyOf,
  type VerifiedApiKey,
} from '../../base/scope/api-key.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import { raiseMinBinary } from '../../db/meta.js';
import { keysetAfter } from '../../base/util/keyset.js';
import { DAY_MS } from '../../base/util/time.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { EXPIRING_KEYS_MIN_BINARY } from '../../base/util/version.js';
import type { ApiKeyRecord } from '../port/types.js';
import type { ApiKeyListRow, ListApiKeysOpts, NewApiKey } from '../port/key-writes.js';
import { cachedStatement } from '../../db/statement-cache.js';

function verifyKey(plaintext: string, stored: string): boolean {
  const parsed = storedScrypt(stored);
  if (!parsed) return false;
  return parsed.matches(scryptSync(plaintext, parsed.salt, parsed.keylen, parsed.params));
}

export interface CreateApiKeyOptions {
  tenantId: string;
  label?: string;
  /** 'admin' | 'member'. Defaults to 'member', like the API layer. */
  role?: 'admin' | 'member';
  /** The auth-resolver subject a self-service key belongs to; unset for keys an admin or the CLI mints. */
  ownerSubject?: string;
  /** ISO time the key stops working; unset means DEFAULT_KEY_TTL_DAYS from now. */
  expiresAt?: string;
}

export interface CreateApiKeyResult {
  keyId: string;
  plaintext: string;
}

export function insertApiKey(db: DatabaseSyncLike, key: NewApiKey): void {
  // Migration v26 (role column) has already run; an older binary ignores expires_at and would honour an expired key, so
  // the store shuts it out before the first one exists.
  if (key.expiresAt !== null) raiseMinBinary(db, EXPIRING_KEYS_MIN_BINARY);
  cachedStatement(
    db,
    `INSERT INTO api_keys (key_id, key_hash, tenant_id, label, created_at, role, owner_subject, expires_at) VALUES ` +
      `(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(key.keyId, key.keyHash, key.tenantId, key.label, key.createdAt, key.role, key.ownerSubject, key.expiresAt);
}

export function createApiKey(db: DatabaseSyncLike, opts: CreateApiKeyOptions): CreateApiKeyResult {
  const { keyId, plaintext, keyHash } = mintApiKey();
  insertApiKey(db, {
    keyId,
    keyHash,
    tenantId: opts.tenantId,
    label: opts.label ?? null,
    role: opts.role ?? 'member',
    createdAt: new Date().toISOString(),
    ownerSubject: opts.ownerSubject ?? null,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + DEFAULT_KEY_TTL_DAYS * DAY_MS).toISOString(),
  });
  return { keyId, plaintext };
}

interface ValidateResult {
  valid: boolean;
  tenantId?: string;
  keyId?: string;
  /** 'admin' | 'member'. Present only when valid=true. */
  role?: 'admin' | 'member';
  /** Scope grants for this key. Present only when valid=true. */
  scopes?: string[];
}

/** The api_keys row for `keyId` with its scope grants; null when no row matches. */
export function readApiKeyRecord(db: DatabaseSyncLike, keyId: string): ApiKeyRecord | null {
  const row = cachedStatement(
    db,
    `SELECT key_hash, tenant_id, revoked_at, role, expires_at, owner_subject FROM api_keys WHERE key_id = ?`,
  ).get(keyId) as
    | {
        key_hash: string;
        tenant_id: string;
        revoked_at: string | null;
        role: string;
        expires_at: string | null;
        owner_subject: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    keyHash: row.key_hash,
    tenantId: row.tenant_id,
    revokedAt: row.revoked_at,
    role: row.role,
    scopes: listScopeGrants(db, keyId),
    expiresAt: row.expires_at,
    ownerSubject: row.owner_subject,
  };
}

/** One full check against the store: shape, row, revocation, expiry, then scrypt. Null for any failure. */
function lookupApiKey(db: DatabaseSyncLike, plaintext: string, now: number): VerifiedApiKey | null {
  const keyId = mintedKeyId(plaintext);
  if (keyId === null) return null;
  const record = readApiKeyRecord(db, keyId);
  return isUsableKey(record, now) && verifyKey(plaintext, record.keyHash) ? verifiedKeyOf(keyId, record) : null;
}

export function validateApiKey(db: DatabaseSyncLike, plaintext: string): ValidateResult {
  const found = lookupApiKey(db, plaintext, Date.now());
  return found ? { valid: true, ...found } : { valid: false };
}

export function revokeApiKey(db: DatabaseSyncLike, keyId: string, at: string = new Date().toISOString()): void {
  cachedStatement(db, `UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL`).run(at, keyId);
}

/** Grant `keyId` read access to one restricted `scope`. Idempotent. */
export function grantScope(db: DatabaseSyncLike, keyId: string, scope: string): void {
  cachedStatement(
    db,
    `INSERT INTO api_key_scope_grants (key_id, scope, granted_at) VALUES (?, ?, ?)
     ON CONFLICT(key_id, scope) DO NOTHING`,
  ).run(keyId, scope, new Date().toISOString());
}

/** Revoke `keyId`'s grant on `scope`. Not an error when no such grant exists. */
export function ungrantScope(db: DatabaseSyncLike, keyId: string, scope: string): void {
  cachedStatement(db, `DELETE FROM api_key_scope_grants WHERE key_id = ? AND scope = ?`).run(keyId, scope);
}

/** Every restricted scope `keyId` may read. */
function listScopeGrants(db: DatabaseSyncLike, keyId: string): string[] {
  const rows = cachedStatement(db, `SELECT scope FROM api_key_scope_grants WHERE key_id = ? ORDER BY scope`).all(
    keyId,
  ) as Array<{ scope: string }>;
  return rows.map((r) => r.scope);
}

interface ApiKeyFilter {
  where: string[];
  params: Array<string | number>;
}

function apiKeyFilter(opts: ListApiKeysOpts): ApiKeyFilter {
  const where: string[] = ['1 = 1'];
  const params: Array<string | number> = [];
  if (opts.active) {
    // In SQL so a page holds `limit` usable keys; toISOString stamps compare correctly as strings.
    where.push('revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)');
    params.push(new Date().toISOString());
  }
  if (opts.tenantId !== ALL_TENANTS) {
    where.push('tenant_id = ?');
    params.push(opts.tenantId);
  }
  if (opts.ownerSubject !== undefined) {
    where.push('owner_subject = ?');
    params.push(opts.ownerSubject);
  }
  if (opts.keyId !== undefined) {
    where.push('key_id = ?');
    params.push(opts.keyId);
  }
  return { where, params };
}

/** Keys newest first, with their row ids, filtered and limited in SQL. */
export function listApiKeyRows(db: DatabaseSyncLike, opts: ListApiKeysOpts): ApiKeyListRow[] {
  const { where, params } = apiKeyFilter(opts);
  const after = keysetAfter('id', 'id', opts.after);
  params.push(...after.params);
  const limitSql = opts.limit === undefined ? '' : ' LIMIT ?';
  if (opts.limit !== undefined) params.push(opts.limit);
  const sql =
    `SELECT id, key_id, tenant_id, label, created_at, revoked_at, role, expires_at, owner_subject FROM api_keys ` +
    `WHERE ${where.join(' AND ')}${after.sql} ORDER BY id DESC${limitSql}`;
  const rows = cachedStatement(db, sql).all(...params) as Array<{
    id: number;
    key_id: string;
    tenant_id: string;
    label: string | null;
    created_at: string;
    revoked_at: string | null;
    role: string;
    expires_at: string | null;
    owner_subject: string | null;
  }>;
  return rows.map((r) => ({
    rowId: r.id,
    key: {
      keyId: r.key_id,
      tenantId: r.tenant_id,
      label: r.label,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      role: r.role === 'admin' ? 'admin' : 'member',
      scopes: listScopeGrants(db, r.key_id),
      expiresAt: r.expires_at,
      ownerSubject: r.owner_subject,
    },
  }));
}

/** Ids of the unrevoked, unexpired keys `ownerSubject` minted in `tenantId`, oldest first. */
export function listLiveOwnedKeyIds(
  db: DatabaseSyncLike,
  tenantId: string,
  ownerSubject: string,
  now: number,
): string[] {
  const rows = cachedStatement(
    db,
    `SELECT key_id, expires_at FROM api_keys WHERE tenant_id = ? AND owner_subject = ? AND revoked_at IS NULL ` +
      `ORDER BY id`,
  ).all(tenantId, ownerSubject) as Array<{ key_id: string; expires_at: string | null }>;
  // Expiry is filtered here, not in SQL, so it follows the same Date.parse rule the key check uses.
  return rows.filter((r) => now < keyExpiryMs(r.expires_at)).map((r) => r.key_id);
}
