import { HttpError } from '../../base/errors/http-errors.js';
import { createRateLimiter } from './rate-limit.js';

// libuv runs scrypt on a pool of four threads by default, so two stay free for file and DNS work.
const MAX_IN_FLIGHT = 2;
const MAX_WAITING = 8;
const KEY_MAX_IN_FLIGHT = 1;
const KEY_MAX_WAITING = 2;
const ADDRESS_MAX_HELD = 2;
const KEY_ADDRESS_BURST = 5;
const KEY_ADDRESS_TRIES_PER_SEC = 5 / 60;

export interface KeyCheckBounds {
  admit(keyId: string, address: string): void;
  run<T>(keyId: string, address: string, derive: () => Promise<T>): Promise<T>;
}

interface Waiter {
  readonly keyId: string;
  readonly start: () => void;
}

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
      inFlight++;
      bump(next.keyId, 1);
      next.start();
    },
  };
}

function keyAddressLimiter(maxKeys: number): ReturnType<typeof createRateLimiter> {
  const idleEvictMs = (KEY_ADDRESS_BURST / KEY_ADDRESS_TRIES_PER_SEC) * 1000;
  return createRateLimiter({
    ratePerSec: KEY_ADDRESS_TRIES_PER_SEC,
    burst: KEY_ADDRESS_BURST,
    idleEvictMs,
    maxKeys,
  });
}

function addressHolds() {
  const heldByAddress = new Map<string, number>();
  return {
    held: (address: string): number => heldByAddress.get(address) ?? 0,
    hold(address: string, by: number): void {
      const next = (heldByAddress.get(address) ?? 0) + by;
      if (next === 0) heldByAddress.delete(address);
      else heldByAddress.set(address, next);
    },
  };
}

/** The tries one address has on one key id, which a server keeps beside the keys it proved: a
 * proved key's re-check spends none. */
export interface KeyAddressTries {
  spend(keyId: string, address: string): void;
}

export function keyAddressTries(maxKeys: number): KeyAddressTries {
  const perKeyAddress = keyAddressLimiter(maxKeys);
  return {
    spend(keyId, address) {
      if (!perKeyAddress.check(`${keyId}\u0000${address}`)) {
        throw new HttpError(
          429,
          'too many key checks from this address',
          perKeyAddress.retryAfterSec,
        );
      }
    },
  };
}

export function keyCheckBounds(): KeyCheckBounds {
  const queue = fairQueue();
  const addresses = addressHolds();
  return {
    admit(keyId, address) {
      if (
        queue.full() ||
        queue.held(keyId) >= KEY_MAX_IN_FLIGHT + KEY_MAX_WAITING ||
        addresses.held(address) >= ADDRESS_MAX_HELD
      ) {
        throw new HttpError(429, 'rate limit exceeded', 1);
      }
    },
    async run(keyId, address, derive) {
      addresses.hold(address, 1);
      try {
        await queue.enter(keyId);
        try {
          return await derive();
        } finally {
          queue.leave(keyId);
        }
      } finally {
        addresses.hold(address, -1);
      }
    },
  };
}
