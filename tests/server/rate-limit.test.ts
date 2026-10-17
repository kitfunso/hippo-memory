import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../../src/server/rate-limit.js';

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

  it('holds the map at maxKeys: while no tracked bucket has refilled, unseen keys share one overflow bucket', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (const k of ['k1', 'k2', 'k3']) rl.check(k, 1000);
    // Had the map grown, each new key would get its own burst of 5; sharing one bucket, the sixth new key is refused.
    const fresh = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((k) => rl.check(k, 1000));
    expect(fresh).toEqual([true, true, true, true, true, false]);
  });

  it('evicts the least-recently-used bucket once it has refilled, so a new key gets its own bucket', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (const k of ['k1', 'k2', 'k3']) rl.check(k, 1000);
    // 100 ms at 10/s refills k1's one spent token: k1 is back at burst, so dropping it gives nothing away.
    for (let i = 0; i < 5; i++) expect(rl.check('k4', 1100)).toBe(true);
    expect(rl.check('k4', 1100)).toBe(false);
    // k4 spent its own bucket, not a shared one: k5 evicts the refilled k2 and still gets a request through.
    expect(rl.check('k5', 1100)).toBe(true);
  });

  it('keeps a throttled key throttled however many new keys churn the full map', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (let i = 0; i < 5; i++) rl.check('attacker', 1000);
    expect(rl.check('attacker', 1000)).toBe(false);
    for (let i = 0; i < 50; i++) rl.check(`rotated-${i}`, 1000);
    expect(rl.check('attacker', 1000)).toBe(false);
  });
});
