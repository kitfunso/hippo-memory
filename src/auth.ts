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
  db.prepare(
    `INSERT INTO api_keys (key_id, key_hash, tenant_id, label, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(keyId, hash, opts.tenantId, opts.label ?? null, new Date().toISOString());
  return { keyId, plaintext };
}

export interface ValidateResult {
  valid: boolean;
  tenantId?: string;
  keyId?: string;
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
    .prepare(`SELECT key_hash, tenant_id, revoked_at FROM api_keys WHERE key_id = ?`)
    .get(keyId) as { key_hash: string; tenant_id: string; revoked_at: string | null } | undefined;

  // Always run verifyKey — on miss/revoked, against DUMMY_HASH so scrypt cost
  // is paid. This reduces timing signal between hit and miss, but the DB
  // lookup itself can still leak via cache effects. v0.40 follow-up: add
  // request-level rate limit on /v1/* to bound enumeration.
  const target = (row && !row.revoked_at) ? row.key_hash : DUMMY_HASH;
  const matches = verifyKey(plaintext, target);
  if (!row || row.revoked_at || !matches) return { valid: false };
  return { valid: true, tenantId: row.tenant_id, keyId };
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
}

export function listApiKeys(db: DatabaseSyncLike, opts: { active: boolean }): ApiKeyListItem[] {
  const sql = opts.active
    ? `SELECT key_id, tenant_id, label, created_at, revoked_at FROM api_keys WHERE revoked_at IS NULL ORDER BY id DESC`
    : `SELECT key_id, tenant_id, label, created_at, revoked_at FROM api_keys ORDER BY id DESC`;
  const rows = db.prepare(sql).all() as Array<{
    key_id: string; tenant_id: string; label: string | null; created_at: string; revoked_at: string | null;
  }>;
  return rows.map(r => ({
    keyId: r.key_id, tenantId: r.tenant_id, label: r.label,
    createdAt: r.created_at, revokedAt: r.revoked_at,
  }));
}
