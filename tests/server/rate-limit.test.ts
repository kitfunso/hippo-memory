import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../../src/surface/server/rate-limit.js';

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

  it('gives each new key its own bucket when the table is full, so none starves another', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (const k of ['k1', 'k2', 'k3']) for (let i = 0; i < 5; i++) rl.check(k, 1000);
    // A shared overflow bucket would run dry after five requests across n1 and n2; each key spends a burst of its own.
    const n1 = Array.from({ length: 6 }, () => rl.check('n1', 1000));
    expect(n1).toEqual([true, true, true, true, true, false]);
    expect(rl.check('n2', 1000)).toBe(true);
  });

  it('evicts the least-recently-used key at maxKeys, not the one that was asking', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (let i = 0; i < 4; i++) rl.check('idle', 1000); // one token left
    for (let i = 0; i < 5; i++) rl.check('busy', 1000); // drained, and the most recent
    rl.check('other', 1000);
    rl.check('n1', 1000); // the table is full: this evicts idle
    expect(rl.check('busy', 1000)).toBe(false);
    // idle starts over with a full burst of five; had it been kept, it would be refused on the second request.
    expect(Array.from({ length: 5 }, () => rl.check('idle', 1000))).toEqual([true, true, true, true, true]);
  });

  it('keeps a throttled key throttled however many new keys churn the full map, while it keeps asking', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (let i = 0; i < 5; i++) rl.check('attacker', 1000);
    for (let i = 0; i < 50; i++) {
      rl.check(`rotated-${i}`, 1000);
      expect(rl.check('attacker', 1000)).toBe(false);
    }
  });

  it('keeps a throttled key throttled when many new keys arrive while it is silent', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (let i = 0; i < 5; i++) rl.check('attacker', 1000);
    for (let i = 0; i < 50; i++) rl.check(`flood-${i}`, 1000);
    expect(rl.check('attacker', 1000)).toBe(false);
  });

  it('drops a refilled bucket before one that can still spend', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (let i = 0; i < 4; i++) rl.check('spending', 1000); // one token left
    rl.check('refilled', 1000); // four tokens at 1000, full again by 1100
    rl.check('later', 1000);
    rl.check('new', 1100); // refilled is full again, so it goes; spending holds two tokens and stays
    expect(Array.from({ length: 3 }, () => rl.check('spending', 1100))).toEqual([true, true, false]);
  });

  it('drops the oldest bucket only when every bucket is throttled', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 2 });
    for (const k of ['first', 'second']) for (let i = 0; i < 5; i++) rl.check(k, 1000);
    rl.check('new', 1000);
    expect(rl.check('second', 1000)).toBe(false);
    expect(rl.check('first', 1000)).toBe(true);
  });
});
