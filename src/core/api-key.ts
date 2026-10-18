// An API key: its shape, its scrypt cost and the mint, so only a hash of the plaintext ever reaches a store.
import { randomBytes, scryptSync } from 'node:crypto';

/** Every minted API key starts with this, so the server can route a bearer token by shape. */
export const API_KEY_PREFIX = 'hk_';
const ID_LEN = 24; // base32 chars after prefix
const SECRET_LEN = 32; // base32 chars after dot
const SCRYPT_KEYLEN = 32;
// Node's defaults, written out so a hash states the cost it was made with.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;
// A stored row must not be able to make verify hang or exhaust memory.
export const SCRYPT_MAX_N = 2 ** 20;
export const SCRYPT_MAX_R = 32;
export const SCRYPT_MAX_P = 16;

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
