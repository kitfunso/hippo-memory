import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/rate-limit.js';

// ratePerSec 10, burst 5: a fresh client may spend 5 at once, then 10/sec.
const OPTS = { ratePerSec: 10, burst: 5, idleEvictMs: 60000, maxKeys: 1000 };

describe('createRateLimiter', () => {
  it('allows a fresh key its first request (full initial bucket)', () => {
    const rl = createRateLimiter(OPTS);
    expect(rl.check('a', 1000)).toBe(true);
  });

  it('allows a burst up to capacity, then denies', () => {
    const rl = createRateLimiter(OPTS);
    for (let i = 0; i < 5; i++) {
      expect(rl.check('a', 1000)).toBe(true);
    }
    expect(rl.check('a', 1000)).toBe(false);
  });

  it('refills at ratePerSec over elapsed time', () => {
    const rl = createRateLimiter(OPTS);
    for (let i = 0; i < 5; i++) rl.check('a', 1000); // drain the bucket
    expect(rl.check('a', 1000)).toBe(false);
    // 10 tokens/sec means 500 ms refills 5 tokens.
    expect(rl.check('a', 1500)).toBe(true);
  });

  it('caps refill at burst — an idle bucket does not accrue past capacity', () => {
    const rl = createRateLimiter(OPTS);
    rl.check('a', 1000);
    // A long idle gap would refill far past burst; it must cap at burst (5).
    for (let i = 0; i < 5; i++) {
      expect(rl.check('a', 100000)).toBe(true);
    }
    expect(rl.check('a', 100000)).toBe(false);
  });

  it('tracks each key independently', () => {
    const rl = createRateLimiter(OPTS);
    for (let i = 0; i < 5; i++) rl.check('a', 1000);
    expect(rl.check('a', 1000)).toBe(false); // a is drained
    expect(rl.check('b', 1000)).toBe(true); // b is untouched
  });

  it('evicts a bucket idle longer than idleEvictMs', () => {
    const rl = createRateLimiter({ ...OPTS, idleEvictMs: 1000 });
    for (let i = 0; i < 5; i++) rl.check('a', 1000); // drain a
    expect(rl.check('a', 1000)).toBe(false);
    // A check far past idleEvictMs fires the sweep, dropping a's idle bucket;
    // a's next check then sees a fresh full bucket.
    rl.check('z', 1_000_000);
    expect(rl.check('a', 1_000_000)).toBe(true);
  });

  it('holds the map at maxKeys, evicting the least-recently-used key', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    rl.check('k1', 1000);
    rl.check('k2', 1000);
    rl.check('k3', 1000); // map full: k1 is least-recently-used
    rl.check('k4', 1000); // inserting k4 evicts k1
    // k1 was evicted, so its bucket is fresh: five requests in a row all pass.
    // Had k1 survived, its 5th request here would be denied.
    for (let i = 0; i < 5; i++) {
      expect(rl.check('k1', 1000)).toBe(true);
    }
  });
});
