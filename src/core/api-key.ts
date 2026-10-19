// An API key: its shape, its scrypt cost, the mint and the checks a stored row passes, so only a hash of the plaintext
// ever reaches a store.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Every minted API key starts with this, so the server can route a bearer token by shape. */
export const API_KEY_PREFIX = 'hk_';
const ID_LEN = 24; // base32 chars after prefix
const SECRET_LEN = 32; // base32 chars after dot
const SCRYPT_KEYLEN = 32;
// Node's defaults, written out so a hash states the cost it was made with.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
// A stored row must not be able to make verify hang or exhaust memory.
const SCRYPT_MAX_N = 2 ** 20;
const SCRYPT_MAX_R = 32;
const SCRYPT_MAX_P = 16;

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly maxmem: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM };

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const MINTED_KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[a-z2-7]{${ID_LEN}}\\.[a-z2-7]{${SECRET_LEN}}$`);

function randBase32(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += BASE32[bytes[i]! % 32];
  return out;
}

function hashKey(plaintext: string): string {
  // Format: scrypt2$<N>$<r>$<p>$<saltHex>$<hashHex>
  const salt = randomBytes(16);
  const hash = scryptSync(plaintext, salt, SCRYPT_KEYLEN, DEFAULT_SCRYPT);
  return `scrypt2$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Days a key lives when its mint names no expiry, so a key nobody remembers stops working by itself. */
export const DEFAULT_KEY_TTL_DAYS = 90;

/** A fresh key: the plaintext its caller sees once, and the scrypt hash a store keeps in its place. */
export interface MintedApiKey {
  keyId: string;
  plaintext: string;
  keyHash: string;
}

export function mintApiKey(): MintedApiKey {
  const keyId = `${API_KEY_PREFIX}${randBase32(ID_LEN)}`;
  const plaintext = `${keyId}.${randBase32(SECRET_LEN)}`;
  return { keyId, plaintext, keyHash: hashKey(plaintext) };
}

/** The key id of a minted-key-shaped token, else null. */
export function mintedKeyId(plaintext: string): string | null {
  return MINTED_KEY_PATTERN.test(plaintext) ? plaintext.slice(0, API_KEY_PREFIX.length + ID_LEN) : null;
}

/** What a stored `scrypt$<saltHex>$<hashHex>` or `scrypt2$<N>$<r>$<p>$<saltHex>$<hashHex>` value asks of a derivation,
 * with the one compare the sync and the pooled check share. */
export interface StoredScrypt {
  readonly salt: Buffer;
  readonly keylen: number;
  readonly params: ScryptParams;
  matches(derived: Buffer): boolean;
}

function validCost(n: number, r: number, p: number): boolean {
  const powerOfTwo = Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
  return (
    powerOfTwo &&
    n <= SCRYPT_MAX_N &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= SCRYPT_MAX_R &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= SCRYPT_MAX_P &&
    128 * n * r <= SCRYPT_MAXMEM
  );
}

/** Null when `stored` has another shape or asks for more work than a verify may do. */
export function storedScrypt(stored: string): StoredScrypt | null {
  const parts = stored.split('$');
  let params = DEFAULT_SCRYPT;
  if (parts.length !== 3 && parts.length !== 6) return null;
  const hashHex = parts[parts.length - 1]!;
  const saltHex = parts[parts.length - 2]!;
  if (parts.length === 3 && parts[0] !== 'scrypt') return null;
  if (parts.length === 6) {
    const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    if (parts[0] !== 'scrypt2' || !validCost(n, r, p)) return null;
    params = { N: n, r, p, maxmem: SCRYPT_MAXMEM };
  }
  const expected = Buffer.from(hashHex, 'hex');
  return {
    salt: Buffer.from(saltHex, 'hex'),
    keylen: expected.length,
    params,
    matches: (derived) => expected.length === derived.length && timingSafeEqual(expected, derived),
  };
}

/** The identity a verified API key carries. */
export interface VerifiedApiKey {
  tenantId: string;
  keyId: string;
  role: 'admin' | 'member';
  scopes: string[];
  ownerSubject?: string | null;
}

/** The fields of a stored key row the checks below read. */
interface KeyRowFacts {
  readonly tenantId: string;
  readonly revokedAt: string | null;
  readonly role: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: string | null;
  readonly ownerSubject?: string | null;
}

/** When a key stops working, in epoch ms: Infinity for null, and already past for a missing
 * field (a store that predates expiry) or a stamp that does not parse, so both fail closed. */
export function keyExpiryMs(expiresAt: string | null | undefined): number {
  if (expiresAt === null) return Infinity;
  if (expiresAt === undefined) return -Infinity;
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** True for a record that is present, unrevoked and unexpired, before any secret check. */
export function isUsableKey<R extends KeyRowFacts>(record: R | null, now: number): record is R {
  // Ids are 120 random bits and not secret, so padding the miss path with scrypt hid nothing and let junk tokens burn
  // CPU.
  if (!record) return false;
  return !record.revokedAt && now < keyExpiryMs(record.expiresAt);
}

/** The verified key a usable record whose secret matched carries. */
export function verifiedKeyOf(keyId: string, record: KeyRowFacts): VerifiedApiKey {
  // Fail-safe to least privilege: any role value but 'admin' reads as 'member'.
  const role: 'admin' | 'member' = record.role === 'admin' ? 'admin' : 'member';
  const key: VerifiedApiKey = { tenantId: record.tenantId, keyId, role, scopes: [...record.scopes] };
  // Only a real name counts as an owner; anything else leaves the key keyed on its own id.
  if (record.ownerSubject) key.ownerSubject = record.ownerSubject;
  return key;
}
