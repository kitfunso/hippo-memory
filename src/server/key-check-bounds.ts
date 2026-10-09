// Bounds on the scrypt work a bearer key check may start: how many derive at once, and how many one address starts for one key id.
import { HttpError } from '../util/http-util.js';
import { createRateLimiter } from './rate-limit.js';

// libuv runs scrypt on a pool of four threads by default, so two stay free for file and DNS work.
const MAX_IN_FLIGHT = 2;
// Four rounds of two, so a burst of unproved keys waits its turn and no wait is longer than four derivations.
const MAX_WAITING = 8;
// Room for a mistyped or rotated secret; a secret is 160 random bits, so this bounds CPU, not guessing.
const KEY_ADDRESS_BURST = 5;
// One more try every 12 s: past its burst, an address starts at most five derivations a minute for one key id.
const KEY_ADDRESS_TRIES_PER_SEC = 5 / 60;

export interface KeyCheckBounds {
  /** Throws the 429 a refused key check answers, before any derivation: no room left to
   * wait (Retry-After 1), or `address` has spent its tries on `keyId` (Retry-After 12). */
  admit(keyId: string, address: string): void;
  /** Runs `derive` now or once a slot frees; `admit` in the same tick keeps the queue within its cap. */
  run<T>(derive: () => Promise<T>): Promise<T>;
}

export function keyCheckBounds(maxKeys: number): KeyCheckBounds {
  // A bucket idle for a full refill is back at its burst, so dropping it then gives nothing away.
  const idleEvictMs = (KEY_ADDRESS_BURST / KEY_ADDRESS_TRIES_PER_SEC) * 1000;
  const perKeyAddress = createRateLimiter({ ratePerSec: KEY_ADDRESS_TRIES_PER_SEC, burst: KEY_ADDRESS_BURST, idleEvictMs, maxKeys });
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  return {
    admit(keyId, address) {
      // Each answers in the words an existing limit uses: the request limit's for a full queue, the address's scrypt bucket's for spent tries.
      if (inFlight >= MAX_IN_FLIGHT && waiting.length >= MAX_WAITING) throw new HttpError(429, 'rate limit exceeded', 1);
      if (!perKeyAddress.check(`${keyId}\u0000${address}`)) {
        throw new HttpError(429, 'too many key checks from this address', perKeyAddress.retryAfterSec);
      }
    },
    async run(derive) {
      if (inFlight < MAX_IN_FLIGHT) inFlight++;
      else await new Promise<void>((resolve) => { waiting.push(resolve); });
      try {
        return await derive();
      } finally {
        // A waiter takes over this slot, so the count stays put across the handover and nothing slips in between.
        const next = waiting.shift();
        if (next) next();
        else inFlight--;
      }
    },
  };
}
