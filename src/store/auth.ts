import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../db/index.js';
import { raiseMinBinary } from '../db/meta.js';
import { keysetAfter, type KeysetPosition } from '../util/keyset.js';
import type { HippoStore } from './index.js';
import { EXPIRING_KEYS_MIN_BINARY } from '../util/version.js';

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

/** What a stored `scrypt$<saltHex>$<hashHex>` value asks of a derivation, with the one compare the sync and the pooled check share. */
interface StoredScrypt {
  readonly salt: Buffer;
  readonly keylen: number;
  matches(derived: Buffer): boolean;
}

/** Null when `stored` has another shape. */
function storedScrypt(stored: string): StoredScrypt | null {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
  const expected = Buffer.from(parts[2]!, 'hex');
  return {
    salt: Buffer.from(parts[1]!, 'hex'),
    keylen: expected.length,
    matches: (derived) => expected.length === derived.length && timingSafeEqual(expected, derived),
  };
}

function verifyKey(plaintext: string, stored: string): boolean {
  const parsed = storedScrypt(stored);
  if (!parsed) return false;
  verifyStats.scryptRuns++;
  return parsed.matches(scryptSync(plaintext, parsed.salt, parsed.keylen));
}

const scryptOffLoop: (password: string, salt: Buffer, keylen: number) => Promise<Buffer> = promisify(scrypt);

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

/** A fresh key: the plaintext its caller sees once, and the scrypt hash a store keeps in its place. */
export interface MintedApiKey extends CreateApiKeyResult {
  keyHash: string;
}

export function mintApiKey(): MintedApiKey {
  const keyId = `${API_KEY_PREFIX}${randBase32(ID_LEN)}`;
  const plaintext = `${keyId}.${randBase32(SECRET_LEN)}`;
  return { keyId, plaintext, keyHash: hashKey(plaintext) };
}

/** One api_keys row as core hands it to a store: the hash of the secret, never the secret. */
export interface NewApiKey {
  readonly keyId: string;
  readonly keyHash: string;
  readonly tenantId: string;
  readonly label: string | null;
  readonly role: 'admin' | 'member';
  readonly createdAt: string;
  /** The auth-resolver subject a self-service key belongs to; null for a key an admin or the CLI mints. */
  readonly ownerSubject: string | null;
  /** ISO time the key stops working; null means it never expires. */
  readonly expiresAt: string | null;
}

export function insertApiKey(db: DatabaseSyncLike, key: NewApiKey): void {
  // openHippoDb runs runMigrations synchronously before returning the db handle,
  // so migration v26 (adds role column) is in place before this INSERT runs.
  // An older binary ignores expires_at and would honour an expired key, so the store shuts it out before the first one exists.
  if (key.expiresAt !== null) raiseMinBinary(db, EXPIRING_KEYS_MIN_BINARY);
  db.prepare(
    `INSERT INTO api_keys (key_id, key_hash, tenant_id, label, created_at, role, owner_subject, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(key.keyId, key.keyHash, key.tenantId, key.label, key.createdAt, key.role, key.ownerSubject, key.expiresAt);
}

export function createApiKey(db: DatabaseSyncLike, opts: CreateApiKeyOpts): CreateApiKeyResult {
  const { keyId, plaintext, keyHash } = mintApiKey();
  insertApiKey(db, {
    keyId, keyHash, tenantId: opts.tenantId, label: opts.label ?? null, role: opts.role ?? 'admin', createdAt: new Date().toISOString(),
    ownerSubject: opts.ownerSubject ?? null, expiresAt: opts.expiresAt ?? null,
  });
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

/** The key id of a minted-key-shaped token, else null. */
function mintedKeyId(plaintext: string): string | null {
  return MINTED_KEY_PATTERN.test(plaintext) ? plaintext.slice(0, API_KEY_PREFIX.length + ID_LEN) : null;
}

/** True for a record that is present, unrevoked and unexpired, before any secret check. */
function isUsable(record: ApiKeyRecord | null, now: number): record is ApiKeyRecord {
  // Ids are 120 random bits and not secret, so padding the miss path with scrypt hid nothing and let junk tokens burn CPU.
  if (!record) return false;
  return !record.revokedAt && now < keyExpiryMs(record.expiresAt);
}

/** The verified key a usable record whose secret matched carries. */
function verifiedKeyOf(keyId: string, record: ApiKeyRecord): VerifiedApiKey {
  // Fail-safe to least privilege: any role value but 'admin' reads as 'member'.
  const role: 'admin' | 'member' = record.role === 'admin' ? 'admin' : 'member';
  const key: VerifiedApiKey = { tenantId: record.tenantId, keyId, role, scopes: [...record.scopes] };
  // Only a real name counts as an owner; anything else leaves the key keyed on its own id.
  if (record.ownerSubject) key.ownerSubject = record.ownerSubject;
  return key;
}

/** One full check against the store: shape, row, revocation, expiry, then scrypt. Null for any failure. */
function lookupApiKey(db: DatabaseSyncLike, plaintext: string, now: number): VerifiedApiKey | null {
  const keyId = mintedKeyId(plaintext);
  if (keyId === null) return null;
  const record = readApiKeyRecord(db, keyId);
  return isUsable(record, now) && verifyKey(plaintext, record.keyHash) ? verifiedKeyOf(keyId, record) : null;
}

export function validateApiKey(db: DatabaseSyncLike, plaintext: string): ValidateResult {
  const found = lookupApiKey(db, plaintext, Date.now());
  return found ? { valid: true, ...found } : { valid: false };
}

const VERIFIED_KEY_CACHE_CAP = 1_000;

function secretDigest(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext).digest();
}

/** LRU of the tokens that matched a stored key hash, so a repeat skips scrypt. Holds a SHA-256 of the token, never the token, and nothing about the key's state. */
export class VerifiedKeyCache {
  // Keyed on the stored hash, so a rotated or re-minted key never meets an old entry; Map order makes the first key the least recent.
  private readonly proven = new Map<string, Buffer>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.proven.size;
  }

  has(keyHash: string, plaintext: string): boolean {
    const digest = this.proven.get(keyHash);
    // A wrong secret misses but leaves the entry, so a flood of bad guesses cannot evict a good key.
    if (!digest || !timingSafeEqual(digest, secretDigest(plaintext))) return false;
    this.proven.delete(keyHash);
    this.proven.set(keyHash, digest);
    return true;
  }

  add(keyHash: string, plaintext: string): void {
    this.proven.delete(keyHash);
    if (this.proven.size >= this.capacity) {
      const oldest = this.proven.keys().next();
      if (!oldest.done) this.proven.delete(oldest.value);
    }
    this.proven.set(keyHash, secretDigest(plaintext));
  }
}

const verifiedKeys = new VerifiedKeyCache(VERIFIED_KEY_CACHE_CAP);

/** A caller's limit on scrypt work, called once per derivation: it may throw to refuse `derive` or hold it in a queue. */
type DerivationBound = (keyId: string, derive: () => Promise<Buffer>) => Promise<Buffer>;

// By stored hash and token, so a burst of requests with one unproved key derives once and is charged once.
const checksInFlight = new Map<string, Promise<boolean>>();

/** Whether `plaintext` is the secret `keyHash` was minted from: a proved token skips scrypt, any other derives on the thread pool. */
async function secretMatches(keyId: string, plaintext: string, keyHash: string, bound?: DerivationBound): Promise<boolean> {
  if (verifiedKeys.has(keyHash, plaintext)) return true;
  const parsed = storedScrypt(keyHash);
  if (!parsed) return false;
  const id = `${keyHash}\u0000${plaintext}`;
  const running = checksInFlight.get(id);
  if (running) return running;
  const derive = (): Promise<Buffer> => {
    verifyStats.scryptRuns++;
    return scryptOffLoop(plaintext, parsed.salt, parsed.keylen);
  };
  const check = (bound ? bound(keyId, derive) : derive()).then((derived) => {
    const matched = parsed.matches(derived);
    // Only successes are kept: keeping misses would let junk tokens fill the cache and evict real keys.
    if (matched) verifiedKeys.add(keyHash, plaintext);
    return matched;
  });
  checksInFlight.set(id, check);
  const forget = (): void => {
    checksInFlight.delete(id);
  };
  void check.then(forget, forget);
  return check;
}

/** Verify a bearer API key against `store`, null when invalid. The key's row is read on every call, so a revoke, expiry, role or scope change by any process applies on the next one. */
export async function verifyApiKeyCached(plaintext: string, store: HippoStore, bound?: DerivationBound): Promise<VerifiedApiKey | null> {
  const keyId = mintedKeyId(plaintext);
  if (keyId === null) return null;
  verifyStats.storeLookups++;
  const record = await store.findApiKey(keyId);
  if (!isUsable(record, Date.now())) return null;
  return (await secretMatches(keyId, plaintext, record.keyHash, bound)) ? verifiedKeyOf(keyId, record) : null;
}

export function revokeApiKey(db: DatabaseSyncLike, keyId: string, at: string = new Date().toISOString()): void {
  db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL`)
    .run(at, keyId);
}

/** Grant `keyId` read access to one restricted `scope`. Idempotent. */
export function grantScope(db: DatabaseSyncLike, keyId: string, scope: string): void {
  db.prepare(
    `INSERT INTO api_key_scope_grants (key_id, scope, granted_at) VALUES (?, ?, ?)
     ON CONFLICT(key_id, scope) DO NOTHING`,
  ).run(keyId, scope, new Date().toISOString());
}

/** Revoke `keyId`'s grant on `scope`. Not an error when no such grant exists. */
export function ungrantScope(db: DatabaseSyncLike, keyId: string, scope: string): void {
  db.prepare(`DELETE FROM api_key_scope_grants WHERE key_id = ? AND scope = ?`).run(keyId, scope);
}

/** Every restricted scope `keyId` may read. */
function listScopeGrants(db: DatabaseSyncLike, keyId: string): string[] {
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

/** Keys of every tenant under `hippoRoot` unless `opts.tenantId` names one. */
export function listApiKeys(hippoRoot: string, opts: ListApiKeysOpts): ApiKeyListItem[] {
  const db = openHippoDb(hippoRoot);
  try {
    return listApiKeyRows(db, opts).map(r => r.key);
  } finally {
    closeHippoDb(db);
  }
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
