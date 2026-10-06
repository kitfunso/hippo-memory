import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSyncLike } from './db.js';
import { raiseMinBinary } from './db/meta.js';
import { keysetAfter, type KeysetPosition } from './keyset.js';
import type { HippoStore } from './store-port.js';
import { EXPIRING_KEYS_MIN_BINARY } from './version.js';

/** Every minted API key starts with this, so the server can route a bearer token by shape. */
export const API_KEY_PREFIX = 'hk_';
const ID_LEN = 24;       // base32 chars after prefix
const SECRET_LEN = 32;   // base32 chars after dot
const SCRYPT_KEYLEN = 32;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const MINTED_KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[a-z2-7]{${ID_LEN}}\\.[a-z2-7]{${SECRET_LEN}}$`);

function randBase32(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += BASE32[bytes[i]! % 32];
  return out;
}

function hashKey(plaintext: string): string {
  // Format: scrypt$<saltHex>$<hashHex>
  const salt = randomBytes(16);
  const hash = scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Counts since process start, so a flood of bad tokens shows as scrypt work, not just as 401s. */
export interface ApiKeyVerifyStats {
  readonly storeLookups: number;
  readonly scryptRuns: number;
}

const verifyStats = { storeLookups: 0, scryptRuns: 0 };

export function apiKeyVerifyStats(): ApiKeyVerifyStats {
  return { ...verifyStats };
}

function verifyKey(plaintext: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  verifyStats.scryptRuns++;
  const actual = scryptSync(plaintext, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface CreateApiKeyOpts {
  tenantId: string;
  label?: string;
  /** 'admin' | 'member'. Defaults to 'admin' (backward-compat for callers that don't specify). */
  role?: 'admin' | 'member';
  /** The auth-resolver subject a self-service key belongs to; unset for keys an admin or the CLI mints. */
  ownerSubject?: string;
  /** ISO time the key stops working; unset means it never expires. */
  expiresAt?: string;
}

export interface CreateApiKeyResult {
  keyId: string;
  plaintext: string;
}

export function createApiKey(db: DatabaseSyncLike, opts: CreateApiKeyOpts): CreateApiKeyResult {
  const keyId = `${API_KEY_PREFIX}${randBase32(ID_LEN)}`;
  const secret = randBase32(SECRET_LEN);
  const plaintext = `${keyId}.${secret}`;
  const hash = hashKey(plaintext);
  // openHippoDb runs runMigrations synchronously before returning the db handle,
  // so migration v26 (adds role column) is in place before this INSERT runs.
  // An older binary ignores expires_at and would honour an expired key, so the store shuts it out before the first one exists.
  if (opts.expiresAt !== undefined) raiseMinBinary(db, EXPIRING_KEYS_MIN_BINARY);
  db.prepare(
    `INSERT INTO api_keys (key_id, key_hash, tenant_id, label, created_at, role, owner_subject, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(keyId, hash, opts.tenantId, opts.label ?? null, new Date().toISOString(), opts.role ?? 'admin', opts.ownerSubject ?? null, opts.expiresAt ?? null);
  return { keyId, plaintext };
}

export interface ValidateResult {
  valid: boolean;
  tenantId?: string;
  keyId?: string;
  /** 'admin' | 'member'. Present only when valid=true. */
  role?: 'admin' | 'member';
  /** Scope grants for this key. Present only when valid=true. */
  scopes?: string[];
}

/** The identity a verified API key carries. */
export interface VerifiedApiKey {
  tenantId: string;
  keyId: string;
  role: 'admin' | 'member';
  scopes: string[];
  ownerSubject?: string | null;
}

/** One api_keys row and its scope grants as a store returns it, revoked or not; the core checks the secret, the role and the expiry. */
export interface ApiKeyRecord {
  keyHash: string;
  tenantId: string;
  revokedAt: string | null;
  role: string;
  scopes: string[];
  /** ISO time the key stops working; null when it never expires. */
  expiresAt: string | null;
  /** Who minted the key; optional because a store that omits it fails safe to an unowned key. */
  ownerSubject?: string | null;
}

/** The api_keys row for `keyId` with its scope grants; null when no row matches. */
export function readApiKeyRecord(db: DatabaseSyncLike, keyId: string): ApiKeyRecord | null {
  // SAFETY: row comes from the SELECT above, which projects exactly
  // key_hash, tenant_id, revoked_at, role, expires_at, owner_subject; `.get` returns undefined when no
  // row matches key_id.
  const row = db
    .prepare(`SELECT key_hash, tenant_id, revoked_at, role, expires_at, owner_subject FROM api_keys WHERE key_id = ?`)
    .get(keyId) as { key_hash: string; tenant_id: string; revoked_at: string | null; role: string; expires_at: string | null; owner_subject: string | null } | undefined;
  if (!row) return null;
  return {
    keyHash: row.key_hash, tenantId: row.tenant_id, revokedAt: row.revoked_at, role: row.role, scopes: listScopeGrants(db, keyId),
    expiresAt: row.expires_at, ownerSubject: row.owner_subject,
  };
}

/** When a key stops working, in epoch ms: Infinity for null, and already past for a missing field (a store that predates expiry) or a stamp that does not parse, so both fail closed. */
function keyExpiryMs(expiresAt: string | null | undefined): number {
  if (expiresAt === null) return Infinity;
  if (expiresAt === undefined) return -Infinity;
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** A key that passed every check, with the time it stops working so a cache entry never outlives it. */
interface CheckedApiKey {
  key: VerifiedApiKey;
  expiresAtMs: number;
}

/** The key id of a minted-key-shaped token, else null. */
function mintedKeyId(plaintext: string): string | null {
  return MINTED_KEY_PATTERN.test(plaintext) ? plaintext.slice(0, API_KEY_PREFIX.length + ID_LEN) : null;
}

/** Revocation, expiry, then scrypt, against a stored record. Null for any failure. */
function checkApiKey(plaintext: string, keyId: string, record: ApiKeyRecord | null, now: number): CheckedApiKey | null {
  // Ids are 120 random bits and not secret, so padding the miss path with scrypt hid nothing and let junk tokens burn CPU.
  if (!record) return null;
  const expiresAtMs = keyExpiryMs(record.expiresAt);
  if (record.revokedAt || now >= expiresAtMs || !verifyKey(plaintext, record.keyHash)) return null;
  // Fail-safe to least privilege: any role value but 'admin' reads as 'member'.
  const role: 'admin' | 'member' = record.role === 'admin' ? 'admin' : 'member';
  const key: VerifiedApiKey = { tenantId: record.tenantId, keyId, role, scopes: [...record.scopes] };
  // Only a real name counts as an owner; anything else leaves the key keyed on its own id.
  if (record.ownerSubject) key.ownerSubject = record.ownerSubject;
  return { key, expiresAtMs };
}

/** One full check against the store: shape, row, revocation, expiry, then scrypt. Null for any failure. */
function lookupApiKey(db: DatabaseSyncLike, plaintext: string, now: number): CheckedApiKey | null {
  const keyId = mintedKeyId(plaintext);
  return keyId === null ? null : checkApiKey(plaintext, keyId, readApiKeyRecord(db, keyId), now);
}

export function validateApiKey(db: DatabaseSyncLike, plaintext: string): ValidateResult {
  const found = lookupApiKey(db, plaintext, Date.now());
  return found ? { valid: true, ...found.key } : { valid: false };
}

/** How long a verified key is trusted without a store read; also the ceiling on a revoke made by another process. */
export const VERIFIED_KEY_TTL_MS = 60_000;
const VERIFIED_KEY_CACHE_CAP = 1_000;

interface VerifiedKeyEntry {
  readonly hippoRoot: string;
  readonly digest: Buffer;
  readonly key: Readonly<VerifiedApiKey>;
  readonly expiresAt: number;
}

function secretDigest(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext).digest();
}

/** LRU of verified keys with an absolute TTL. Holds a SHA-256 of the token, never the token. */
export class VerifiedKeyCache {
  // Map iterates in insertion order, so re-inserting on a hit makes the first key the least recent.
  private readonly entries = new Map<string, VerifiedKeyEntry>();
  private deletes = 0;

  constructor(private readonly capacity: number, private readonly ttlMs: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** Moves on every delete, so a store read that straddled a revoke or grant is not cached. */
  get epoch(): number {
    return this.deletes;
  }

  get(hippoRoot: string, keyId: string, plaintext: string, now: number): VerifiedApiKey | undefined {
    const entry = this.entries.get(keyId);
    if (!entry || entry.hippoRoot !== hippoRoot) return undefined;
    if (now >= entry.expiresAt) {
      this.entries.delete(keyId);
      return undefined;
    }
    // A wrong secret misses but leaves the entry, so a flood of bad guesses cannot evict a good key.
    if (!timingSafeEqual(entry.digest, secretDigest(plaintext))) return undefined;
    this.entries.delete(keyId);
    this.entries.set(keyId, entry);
    return { ...entry.key, scopes: [...entry.key.scopes] };
  }

  set(hippoRoot: string, keyId: string, plaintext: string, key: VerifiedApiKey, now: number, keyExpiresAtMs = Infinity): void {
    this.entries.delete(keyId);
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const frozen = Object.freeze({ ...key, scopes: [...key.scopes] });
    // A key that expires inside the TTL leaves the cache at its expiry, so the cache never extends its life.
    const expiresAt = Math.min(now + this.ttlMs, keyExpiresAtMs);
    this.entries.set(keyId, { hippoRoot, digest: secretDigest(plaintext), key: frozen, expiresAt });
  }

  delete(keyId: string): void {
    this.deletes++;
    this.entries.delete(keyId);
  }
}

// SHORTCUT: per-process cache, so a revoke or scope change made by another process (the CLI) lands within VERIFIED_KEY_TTL_MS; a shared revocation epoch in the store if that is too slow.
const verifiedKeys = new VerifiedKeyCache(VERIFIED_KEY_CACHE_CAP, VERIFIED_KEY_TTL_MS);

/** Verify a bearer API key against `store`, served at `hippoRoot`; a cache hit skips both scrypt and the store. Null when invalid. A throw from `beforeLookup` refuses a miss before the store read and scrypt. */
export async function verifyApiKeyCached(hippoRoot: string, plaintext: string, store: HippoStore, beforeLookup?: () => void): Promise<VerifiedApiKey | null> {
  const keyId = mintedKeyId(plaintext);
  if (keyId === null) return null;
  const hit = verifiedKeys.get(hippoRoot, keyId, plaintext, Date.now());
  if (hit) return hit;
  beforeLookup?.();
  verifyStats.storeLookups++;
  const epoch = verifiedKeys.epoch;
  const found = checkApiKey(plaintext, keyId, await store.findApiKey(keyId), Date.now());
  // Only successes are cached: caching misses would let junk tokens fill the cache and evict real keys.
  if (found && verifiedKeys.epoch === epoch) verifiedKeys.set(hippoRoot, keyId, plaintext, found.key, Date.now(), found.expiresAtMs);
  return found?.key ?? null;
}

export function revokeApiKey(db: DatabaseSyncLike, keyId: string): void {
  db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), keyId);
  verifiedKeys.delete(keyId);
}

/** Grant `keyId` read access to one restricted `scope`. Idempotent. */
export function grantScope(db: DatabaseSyncLike, keyId: string, scope: string): void {
  db.prepare(
    `INSERT INTO api_key_scope_grants (key_id, scope, granted_at) VALUES (?, ?, ?)
     ON CONFLICT(key_id, scope) DO NOTHING`,
  ).run(keyId, scope, new Date().toISOString());
  verifiedKeys.delete(keyId);
}

/** Revoke `keyId`'s grant on `scope`. Not an error when no such grant exists. */
export function ungrantScope(db: DatabaseSyncLike, keyId: string, scope: string): void {
  db.prepare(`DELETE FROM api_key_scope_grants WHERE key_id = ? AND scope = ?`).run(keyId, scope);
  verifiedKeys.delete(keyId);
}

/** Every restricted scope `keyId` may read. */
export function listScopeGrants(db: DatabaseSyncLike, keyId: string): string[] {
  // SAFETY: rows' shape matches the single `scope` column named in the SELECT above.
  const rows = db
    .prepare(`SELECT scope FROM api_key_scope_grants WHERE key_id = ? ORDER BY scope`)
    .all(keyId) as Array<{ scope: string }>;
  return rows.map((r) => r.scope);
}

export interface ApiKeyListItem {
  keyId: string;
  tenantId: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  /**
   * Authorization role bound to the key, from the `role` column (schema migration v26).
   * Fail-safe-to-member cast: any non-'admin' value reads as 'member'.
   */
  role: 'admin' | 'member';
  /** Restricted scopes this key may read. */
  scopes: string[];
  /** ISO time the key stops working; null when it never expires. */
  expiresAt: string | null;
  /** The auth-resolver subject that minted this key for itself; null for keys an admin or the CLI minted. */
  ownerSubject: string | null;
}

export interface ListApiKeysOpts {
  /** Only keys that still work: unrevoked and unexpired. */
  active: boolean;
  /** Only this tenant's keys; omit for every tenant (the CLI's single-tenant view). */
  tenantId?: string;
  /** Only keys minted by this auth-resolver subject. */
  ownerSubject?: string;
  /** Only this one key. */
  keyId?: string;
  /** Resume after this row: the position the previous page ended on (key and id are both the row id). */
  after?: KeysetPosition;
  limit?: number;
}

/** A listed key plus its row id, the paging key the list item itself does not expose. */
export interface ApiKeyListRow {
  rowId: number;
  key: ApiKeyListItem;
}

/** Keys newest first, with their row ids, filtered and limited in SQL. */
export function listApiKeyRows(db: DatabaseSyncLike, opts: ListApiKeysOpts): ApiKeyListRow[] {
  const where: string[] = ['1 = 1'];
  const params: Array<string | number> = [];
  if (opts.active) {
    // In SQL so a page holds `limit` usable keys; toISOString stamps compare correctly as strings.
    where.push('revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)');
    params.push(new Date().toISOString());
  }
  if (opts.tenantId !== undefined) {
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
  const after = keysetAfter('id', 'id', opts.after);
  params.push(...after.params);
  const limitSql = opts.limit === undefined ? '' : ' LIMIT ?';
  if (opts.limit !== undefined) params.push(opts.limit);
  const sql = `SELECT id, key_id, tenant_id, label, created_at, revoked_at, role, expires_at, owner_subject FROM api_keys WHERE ${where.join(' AND ')}${after.sql} ORDER BY id DESC${limitSql}`;
  // SAFETY: the SELECT above projects exactly these 9 columns, in this order.
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number; key_id: string; tenant_id: string; label: string | null; created_at: string; revoked_at: string | null; role: string;
    expires_at: string | null; owner_subject: string | null;
  }>;
  return rows.map(r => ({
    rowId: r.id,
    key: {
      keyId: r.key_id, tenantId: r.tenant_id, label: r.label,
      createdAt: r.created_at, revokedAt: r.revoked_at,
      role: r.role === 'admin' ? 'admin' : 'member',
      scopes: listScopeGrants(db, r.key_id),
      expiresAt: r.expires_at, ownerSubject: r.owner_subject,
    },
  }));
}

export function listApiKeys(db: DatabaseSyncLike, opts: ListApiKeysOpts): ApiKeyListItem[] {
  return listApiKeyRows(db, opts).map(r => r.key);
}

/** Ids of the unrevoked, unexpired keys `ownerSubject` minted in `tenantId`, oldest first. */
export function listLiveOwnedKeyIds(db: DatabaseSyncLike, tenantId: string, ownerSubject: string, now: number): string[] {
  // SAFETY: the SELECT names exactly these two columns.
  const rows = db
    .prepare(`SELECT key_id, expires_at FROM api_keys WHERE tenant_id = ? AND owner_subject = ? AND revoked_at IS NULL ORDER BY id`)
    .all(tenantId, ownerSubject) as Array<{ key_id: string; expires_at: string | null }>;
  // Expiry is filtered here, not in SQL, so it follows the same Date.parse rule the key check uses.
  return rows.filter((r) => now < keyExpiryMs(r.expires_at)).map((r) => r.key_id);
}
