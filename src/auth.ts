import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSyncLike } from './db.js';

const KEY_PREFIX = 'hk_';
const ID_LEN = 24;       // base32 chars after prefix
const SECRET_LEN = 32;   // base32 chars after dot
const SCRYPT_KEYLEN = 32;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

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

// Constant dummy hash precomputed once at module load. Used by validateApiKey
// to pay the scrypt cost on the miss path (unknown / revoked / malformed key)
// so the timing signal between hit and miss is reduced. The DB lookup branch
// itself can still leak via cache effects — v0.40 follow-up: request-level
// rate limit on /v1/* to bound key-id enumeration. Stored format identical to
// real hashes: scrypt$saltHex$hashHex.
const DUMMY_PLAINTEXT = 'hk_dummy_constant_padding_for_timing.dummy_secret_padding_for_timing_x';
const DUMMY_HASH = hashKey(DUMMY_PLAINTEXT);

function verifyKey(plaintext: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
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
  const keyId = `${KEY_PREFIX}${randBase32(ID_LEN)}`;
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
}

export function validateApiKey(db: DatabaseSyncLike, plaintext: string): ValidateResult {
  const dot = plaintext.indexOf('.');
  if (dot < 0) {
    // Malformed input still pays the scrypt cost so caller cannot distinguish
    // "no dot" from "unknown key_id" by timing.
    verifyKey(DUMMY_PLAINTEXT, DUMMY_HASH);
    return { valid: false };
  }
  const keyId = plaintext.slice(0, dot);
  const row = db
    .prepare(`SELECT key_hash, tenant_id, revoked_at, role FROM api_keys WHERE key_id = ?`)
    .get(keyId) as { key_hash: string; tenant_id: string; revoked_at: string | null; role: string } | undefined;

  // Always run verifyKey — on miss/revoked, against DUMMY_HASH so scrypt cost
  // is paid. This reduces timing signal between hit and miss, but the DB
  // lookup itself can still leak via cache effects. v0.40 follow-up: add
  // request-level rate limit on /v1/* to bound enumeration.
  const target = (row && !row.revoked_at) ? row.key_hash : DUMMY_HASH;
  const matches = verifyKey(plaintext, target);
  if (!row || row.revoked_at || !matches) return { valid: false };
  // v1.12.0: fail-safe to least privilege — only 'admin' is admitted as admin,
  // anything else (including future schema drift, manual DB tampering inserting
  // 'superuser', or a NULL slipped past the NOT NULL constraint) downgrades to
  // 'member'. The migration constrains to 'admin' DEFAULT, but defense-in-depth.
  const role: 'admin' | 'member' = row.role === 'admin' ? 'admin' : 'member';
  return { valid: true, tenantId: row.tenant_id, keyId, role };
}

export function revokeApiKey(db: DatabaseSyncLike, keyId: string): void {
  db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), keyId);
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
}

export function listApiKeys(db: DatabaseSyncLike, opts: { active: boolean }): ApiKeyListItem[] {
  const sql = opts.active
    ? `SELECT key_id, tenant_id, label, created_at, revoked_at, role FROM api_keys WHERE revoked_at IS NULL ORDER BY id DESC`
    : `SELECT key_id, tenant_id, label, created_at, revoked_at, role FROM api_keys ORDER BY id DESC`;
  const rows = db.prepare(sql).all() as Array<{
    key_id: string; tenant_id: string; label: string | null; created_at: string; revoked_at: string | null; role: string;
  }>;
  return rows.map(r => ({
    keyId: r.key_id, tenantId: r.tenant_id, label: r.label,
    createdAt: r.created_at, revokedAt: r.revoked_at,
    role: r.role === 'admin' ? 'admin' : 'member',
  }));
}
