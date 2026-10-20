// Bounds on the scrypt work a bearer key check may start: how many derive at once, how many of those one key id holds,
// and how many one address starts for one key id.
import { HttpError } from '../../base/util/http-util.js';
import { createRateLimiter } from './rate-limit.js';

// libuv runs scrypt on a pool of four threads by default, so two stay free for file and DNS work.
const MAX_IN_FLIGHT = 2;
// Four rounds of two, so a burst of unproved keys waits its turn and no wait is longer than four derivations.
const MAX_WAITING = 8;
// Key ids are not secret, so one key id flooded from many addresses keeps a slot and two waits, never the whole queue.
// A proved key's concurrent checks share one derivation, so its own first use never needs a second slot.
const KEY_MAX_IN_FLIGHT = 1;
const KEY_MAX_WAITING = 2;
// Room for a mistyped or rotated secret; a secret is 160 random bits, so this bounds CPU, not guessing.
const KEY_ADDRESS_BURST = 5;
// One more try every 12 s: past its burst, an address starts at most five derivations a minute for one key id.
const KEY_ADDRESS_TRIES_PER_SEC = 5 / 60;

export interface KeyCheckBounds {
  /** Throws the 429 a refused key check answers, before any derivation: no room left to wait, or `keyId` already holds
   * its share of the queue (Retry-After 1), or `address` has spent its tries on `keyId` (Retry-After 12). */
  admit(keyId: string, address: string): void;
  /** Runs `derive` for `keyId` now or once a slot frees that the key may take; `admit` in the same tick keeps the queue
   * within its caps. */
  run<T>(keyId: string, derive: () => Promise<T>): Promise<T>;
}

interface Waiter {
  readonly keyId: string;
  readonly start: () => void;
}

/** Derivations running and waiting, in total and per key id; a slot goes to the oldest waiter whose key has room. */
function fairQueue() {
  let inFlight = 0;
  const running = new Map<string, number>();
  const waiting: Waiter[] = [];
  const bump = (keyId: string, by: number): void => {
    const next = (running.get(keyId) ?? 0) + by;
    if (next === 0) running.delete(keyId);
    else running.set(keyId, next);
  };
  const hasRoom = (keyId: string): boolean => (running.get(keyId) ?? 0) < KEY_MAX_IN_FLIGHT;
  return {
    full: (): boolean => inFlight >= MAX_IN_FLIGHT && waiting.length >= MAX_WAITING,
    held: (keyId: string): number =>
      (running.get(keyId) ?? 0) + waiting.filter((waiter) => waiter.keyId === keyId).length,
    async enter(keyId: string): Promise<void> {
      if (inFlight < MAX_IN_FLIGHT && hasRoom(keyId)) {
        inFlight++;
        bump(keyId, 1);
        return;
      }
      await new Promise<void>((start) => waiting.push({ keyId, start }));
    },
    leave(keyId: string): void {
      bump(keyId, -1);
      inFlight--;
      const at = waiting.findIndex((waiter) => hasRoom(waiter.keyId));
      const next = at === -1 ? undefined : waiting.splice(at, 1)[0];
      if (next === undefined) return;
      // The count moves before the waiter resumes, so nothing slips in between the handover.
      inFlight++;
      bump(next.keyId, 1);
      next.start();
    },
  };
}

export function keyCheckBounds(maxKeys: number): KeyCheckBounds {
  // A bucket idle for a full refill is back at its burst, so dropping it then gives nothing away.
  const idleEvictMs = (KEY_ADDRESS_BURST / KEY_ADDRESS_TRIES_PER_SEC) * 1000;
  const perKeyAddress = createRateLimiter({
    ratePerSec: KEY_ADDRESS_TRIES_PER_SEC,
    burst: KEY_ADDRESS_BURST,
    idleEvictMs,
    maxKeys,
  });
  const queue = fairQueue();
  return {
    admit(keyId, address) {
      // Each answers in the words an existing limit uses: the request limit's for a full queue or a key past its share,
      // the address's scrypt bucket's for spent tries.
      if (queue.full() || queue.held(keyId) >= KEY_MAX_IN_FLIGHT + KEY_MAX_WAITING) {
        throw new HttpError(429, 'rate limit exceeded', 1);
      }
      if (!perKeyAddress.check(`${keyId}\u0000${address}`)) {
        throw new HttpError(429, 'too many key checks from this address', perKeyAddress.retryAfterSec);
      }
    },
    async run(keyId, derive) {
      await queue.enter(keyId);
      try {
        return await derive();
      } finally {
        queue.leave(keyId);
      }
    },
  };
}
