import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';
import { keysetAfter, type KeysetPosition } from './keyset.js';

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
  /** v1.12.0 A5 v2 sub-1: 'admin' | 'member'. Defaults to 'admin' (backward-compat for callers that don't specify). */
  role?: 'admin' | 'member';
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
  // v1.12.0: 6-column INSERT including role. Boot-order guarantee:
  // openHippoDb runs runMigrations synchronously before returning the db
  // handle, so migration v26 (adds role column) is in place before this
  // INSERT runs.
  db.prepare(
    `INSERT INTO api_keys (key_id, key_hash, tenant_id, label, created_at, role) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(keyId, hash, opts.tenantId, opts.label ?? null, new Date().toISOString(), opts.role ?? 'admin');
  return { keyId, plaintext };
}

export interface ValidateResult {
  valid: boolean;
  tenantId?: string;
  keyId?: string;
  /** v1.12.0 A5 v2 sub-1: 'admin' | 'member'. Present only when valid=true. */
  role?: 'admin' | 'member';
  /** EI2: scope grants for this key. Present only when valid=true. */
  scopes?: string[];
}

/** The identity a verified API key carries. */
export interface VerifiedApiKey {
  tenantId: string;
  keyId: string;
  role: 'admin' | 'member';
  scopes: string[];
}

/** One full check against the store: shape, row, revocation, then scrypt. Null for any failure. */
function lookupApiKey(db: DatabaseSyncLike, plaintext: string): VerifiedApiKey | null {
  if (!MINTED_KEY_PATTERN.test(plaintext)) return null;
  const keyId = plaintext.slice(0, API_KEY_PREFIX.length + ID_LEN);
  // SAFETY: row comes from the SELECT above, which projects exactly
  // key_hash, tenant_id, revoked_at, role; `.get` returns undefined when no
  // row matches key_id.
  const row = db
    .prepare(`SELECT key_hash, tenant_id, revoked_at, role FROM api_keys WHERE key_id = ?`)
    .get(keyId) as { key_hash: string; tenant_id: string; revoked_at: string | null; role: string } | undefined;
  // Ids are 120 random bits and not secret, so padding the miss path with scrypt hid nothing and let junk tokens burn CPU.
  if (!row || row.revoked_at || !verifyKey(plaintext, row.key_hash)) return null;
  // Fail-safe to least privilege: any role value but 'admin' reads as 'member'.
  const role: 'admin' | 'member' = row.role === 'admin' ? 'admin' : 'member';
  return { tenantId: row.tenant_id, keyId, role, scopes: listScopeGrants(db, keyId) };
}

export function validateApiKey(db: DatabaseSyncLike, plaintext: string): ValidateResult {
  const key = lookupApiKey(db, plaintext);
  return key ? { valid: true, ...key } : { valid: false };
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

  constructor(private readonly capacity: number, private readonly ttlMs: number) {}

  get size(): number {
    return this.entries.size;
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

  set(hippoRoot: string, keyId: string, plaintext: string, key: VerifiedApiKey, now: number): void {
    this.entries.delete(keyId);
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const frozen = Object.freeze({ ...key, scopes: [...key.scopes] });
    this.entries.set(keyId, { hippoRoot, digest: secretDigest(plaintext), key: frozen, expiresAt: now + this.ttlMs });
  }

  delete(keyId: string): void {
    this.entries.delete(keyId);
  }
}

// SHORTCUT: per-process cache, so a revoke or scope change made by another process (the CLI) lands within VERIFIED_KEY_TTL_MS; a shared revocation epoch in the store if that is too slow.
const verifiedKeys = new VerifiedKeyCache(VERIFIED_KEY_CACHE_CAP, VERIFIED_KEY_TTL_MS);

/** Verify a bearer API key for `hippoRoot`; a cache hit skips both scrypt and the DB open. Null when invalid. */
export function verifyApiKeyCached(hippoRoot: string, plaintext: string): VerifiedApiKey | null {
  if (!MINTED_KEY_PATTERN.test(plaintext)) return null;
  const keyId = plaintext.slice(0, API_KEY_PREFIX.length + ID_LEN);
  const hit = verifiedKeys.get(hippoRoot, keyId, plaintext, Date.now());
  if (hit) return hit;
  verifyStats.storeLookups++;
  const db = openHippoDb(hippoRoot);
  let key: VerifiedApiKey | null;
  try {
    key = lookupApiKey(db, plaintext);
  } finally {
    closeHippoDb(db);
  }
  // Only successes are cached: caching misses would let junk tokens fill the cache and evict real keys.
  if (key) verifiedKeys.set(hippoRoot, keyId, plaintext, key, Date.now());
  return key;
}

export function revokeApiKey(db: DatabaseSyncLike, keyId: string): void {
  db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), keyId);
  verifiedKeys.delete(keyId);
}

/** EI2: grant `keyId` read access to one restricted `scope`. Idempotent. */
export function grantScope(db: DatabaseSyncLike, keyId: string, scope: string): void {
  db.prepare(
    `INSERT INTO api_key_scope_grants (key_id, scope, granted_at) VALUES (?, ?, ?)
     ON CONFLICT(key_id, scope) DO NOTHING`,
  ).run(keyId, scope, new Date().toISOString());
  verifiedKeys.delete(keyId);
}

/** EI2: revoke `keyId`'s grant on `scope`. Not an error when no such grant exists. */
export function ungrantScope(db: DatabaseSyncLike, keyId: string, scope: string): void {
  db.prepare(`DELETE FROM api_key_scope_grants WHERE key_id = ? AND scope = ?`).run(keyId, scope);
  verifiedKeys.delete(keyId);
}

/** EI2: every restricted scope `keyId` may read. */
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
   * v1.12.3: authorization role bound to the key. SELECT extended to read
   * the `role` column (added in schema migration v26 by v1.12.0 sub-1).
   * Fail-safe-to-member cast: any non-'admin' value reads as 'member'.
   */
  role: 'admin' | 'member';
  /** EI2: restricted scopes this key may read. */
  scopes: string[];
}

export interface ListApiKeysOpts {
  active: boolean;
  /** Only this tenant's keys; omit for every tenant (the CLI's single-tenant view). */
  tenantId?: string;
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
  if (opts.active) where.push('revoked_at IS NULL');
  if (opts.tenantId !== undefined) {
    where.push('tenant_id = ?');
    params.push(opts.tenantId);
  }
  const after = keysetAfter('id', 'id', opts.after);
  params.push(...after.params);
  const limitSql = opts.limit === undefined ? '' : ' LIMIT ?';
  if (opts.limit !== undefined) params.push(opts.limit);
  const sql = `SELECT id, key_id, tenant_id, label, created_at, revoked_at, role FROM api_keys WHERE ${where.join(' AND ')}${after.sql} ORDER BY id DESC${limitSql}`;
  // SAFETY: the SELECT above projects exactly these 7 columns, in this order.
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number; key_id: string; tenant_id: string; label: string | null; created_at: string; revoked_at: string | null; role: string;
  }>;
  return rows.map(r => ({
    rowId: r.id,
    key: {
      keyId: r.key_id, tenantId: r.tenant_id, label: r.label,
      createdAt: r.created_at, revokedAt: r.revoked_at,
      role: r.role === 'admin' ? 'admin' : 'member',
      scopes: listScopeGrants(db, r.key_id),
    },
  }));
}

export function listApiKeys(db: DatabaseSyncLike, opts: ListApiKeysOpts): ApiKeyListItem[] {
  return listApiKeyRows(db, opts).map(r => r.key);
}
