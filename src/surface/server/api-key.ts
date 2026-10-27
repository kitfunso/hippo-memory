// The server's bearer-key check: it reads the key's row through the store port and proves the
// secret off the loop.
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
  // Keyed on the stored hash, so a rotated or re-minted key never meets an old entry.
  private readonly proven: Lru<Buffer>;

  constructor(capacity: number) {
    this.proven = new Lru(capacity);
  }

  get size(): number {
    return this.proven.size;
  }

  has(keyHash: string, plaintext: string): boolean {
    const digest = this.proven.peek(keyHash);
    // A wrong secret misses but leaves the entry, so a flood of bad guesses cannot evict a good
    // key.
    if (!digest || !timingSafeEqual(digest, secretDigest(plaintext))) return false;
    return this.proven.get(keyHash) !== undefined;
  }

  add(keyHash: string, plaintext: string): void {
    this.proven.set(keyHash, secretDigest(plaintext));
  }
}

/**
 * A caller's limit on scrypt work, called once per derivation: it may throw to refuse `derive` or
 * hold it in a queue.
 */
type DerivationBound = (keyId: string, derive: () => Promise<Buffer>) => Promise<Buffer>;

/** One server's key checks: the tokens it proved, the derivations it is running, and the tries
 * each address has spent on a key id. */
export class KeyVerifier {
  readonly #verified = new VerifiedKeyCache(VERIFIED_KEY_CACHE_CAP);
  // Beside the proofs, so a server restarted in the same process charges a proved key's first
  // re-check to its own budget and not to the last server's.
  readonly #tries = keyAddressTries(LIMITER_MAX_KEYS);
  // By stored hash and a digest of the token, never the token, so a burst with one unproved key
  // derives once and is charged once.
  readonly #inFlight = new Map<string, Promise<boolean>>();

  /** Throws the 429 a refused derivation answers: the process's scrypt queue is full, or `address`
   * has spent its tries on `keyId` here. */
  admit(keyId: string, address: string): void {
    keyChecks.admit(keyId, address);
    this.#tries.spend(keyId, address);
  }

  /** The bound one caller's derivations run under: admit, then `charged`, then the process's
   * scrypt queue, which every verifier shares. */
  boundFor(address: string, charged: () => void): DerivationBound {
    return (keyId, derive) => {
      this.admit(keyId, address);
      charged();
      return keyChecks.run(keyId, address, derive);
    };
  }

  /** Verify a bearer API key against `store`, null when invalid. The key's row is read on every
   * call, so a revoke, expiry, role or scope change by any process applies on the next one. */
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
      // The caller charges its failed-auth budget here without a derivation, so probing key ids
      // costs the server nothing.
      onUnusable?.();
      return null;
    }
    const proved = { keyId, plaintext, keyHash: record.keyHash };
    return (await secretMatches(proved, this.#verified, this.#inFlight, bound))
      ? verifiedKeyOf(keyId, record)
      : null;
  }
}

/** Whether `plaintext` is the secret `keyHash` was minted from: a proved token skips scrypt, any
 * other derives on the thread pool. */
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
    // Only successes are kept: keeping misses would let junk tokens fill the cache and evict real
    // keys.
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
