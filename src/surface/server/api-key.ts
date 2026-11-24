import { createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  isUsableKey,
  mintedKeyId,
  storedScrypt,
  verifiedKeyOf,
  type ScryptParams,
  type VerifiedApiKey,
} from '../../base/scope/api-key.js';
import type { RequiredStore } from '../../base/ports/store.js';
import { Lru } from '../../base/util/lru.js';
import { keyAddressTries, keyCheckBounds } from './key-check-bounds.js';
import { LIMITER_MAX_KEYS } from './rate-limit.js';

const scryptOffLoop: (
  password: string,
  salt: Buffer,
  keylen: number,
  params: ScryptParams,
) => Promise<Buffer> = promisify(scrypt);

// One for the process, as libuv's scrypt pool is: its bound of two derivations holds across every
// server here.
export const keyChecks = keyCheckBounds();

const VERIFIED_KEY_CACHE_CAP = 1_000;

function secretDigest(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext).digest();
}

/** LRU of the tokens that matched a stored key hash, so a repeat skips scrypt. Holds a SHA-256
 * of the token, never the token, and nothing about the key's state. */
export class VerifiedKeyCache {
  private readonly proven: Lru<Buffer>;

  constructor(capacity: number) {
    this.proven = new Lru(capacity);
  }

  get size(): number {
    return this.proven.size;
  }

  has(keyHash: string, plaintext: string): boolean {
    const digest = this.proven.peek(keyHash);
    if (!digest || !timingSafeEqual(digest, secretDigest(plaintext))) return false;
    return this.proven.get(keyHash) !== undefined;
  }

  add(keyHash: string, plaintext: string): void {
    this.proven.set(keyHash, secretDigest(plaintext));
  }
}

type DerivationBound = (keyId: string, derive: () => Promise<Buffer>) => Promise<Buffer>;

/** One server's key checks: the tokens it proved, the derivations it is running, and the tries
 * each address has spent on a key id. */
export class KeyVerifier {
  readonly #verified = new VerifiedKeyCache(VERIFIED_KEY_CACHE_CAP);
  readonly #tries = keyAddressTries(LIMITER_MAX_KEYS);
  readonly #inFlight = new Map<string, Promise<boolean>>();

  admit(keyId: string, address: string): void {
    keyChecks.admit(keyId, address);
    this.#tries.spend(keyId, address);
  }

  boundFor(address: string, charged: () => void): DerivationBound {
    return (keyId, derive) => {
      this.admit(keyId, address);
      charged();
      return keyChecks.run(keyId, address, derive);
    };
  }

  async verify(
    plaintext: string,
    store: RequiredStore,
    bound?: DerivationBound,
    onUnusable?: () => void,
  ): Promise<VerifiedApiKey | null> {
    const keyId = mintedKeyId(plaintext);
    if (keyId === null) return null;
    const record = await store.findApiKey(keyId);
    if (!isUsableKey(record, Date.now())) {
      onUnusable?.();
      return null;
    }
    const proved = { keyId, plaintext, keyHash: record.keyHash };
    return (await secretMatches(proved, this.#verified, this.#inFlight, bound))
      ? verifiedKeyOf(keyId, record)
      : null;
  }
}

async function secretMatches(
  { keyId, plaintext, keyHash }: { keyId: string; plaintext: string; keyHash: string },
  verifiedKeys: VerifiedKeyCache,
  checksInFlight: Map<string, Promise<boolean>>,
  bound?: DerivationBound,
): Promise<boolean> {
  if (verifiedKeys.has(keyHash, plaintext)) return true;
  const parsed = storedScrypt(keyHash);
  if (!parsed) return false;
  const id = `${keyHash}\u0000${secretDigest(plaintext).toString('hex')}`;
  const running = checksInFlight.get(id);
  if (running) return running;
  const derive = (): Promise<Buffer> =>
    scryptOffLoop(plaintext, parsed.salt, parsed.keylen, parsed.params);
  const check = (bound ? bound(keyId, derive) : derive()).then((derived) => {
    const matched = parsed.matches(derived);
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
