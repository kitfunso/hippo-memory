import { describe, it, expect, vi } from 'vitest';
import { createRateLimiter } from '../../src/surface/server/rate-limit.js';

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
    for (let i = 0; i < 5; i++) rl.check('a', 1000);
    expect(rl.check('a', 1000)).toBe(false);
    expect(rl.check('a', 1500)).toBe(true);
  });

  it('caps refill at burst — an idle bucket does not accrue past capacity', () => {
    const rl = createRateLimiter(OPTS);
    rl.check('a', 1000);
    for (let i = 0; i < 5; i++) {
      expect(rl.check('a', 100000)).toBe(true);
    }
    expect(rl.check('a', 100000)).toBe(false);
  });

  it('tracks each key independently', () => {
    const rl = createRateLimiter(OPTS);
    for (let i = 0; i < 5; i++) rl.check('a', 1000);
    expect(rl.check('a', 1000)).toBe(false);
    expect(rl.check('b', 1000)).toBe(true);
  });

  it('evicts a bucket idle longer than idleEvictMs', () => {
    const rl = createRateLimiter({ ...OPTS, idleEvictMs: 1000 });
    for (let i = 0; i < 5; i++) rl.check('a', 1000);
    expect(rl.check('a', 1000)).toBe(false);
    rl.check('z', 1_000_000);
    expect(rl.check('a', 1_000_000)).toBe(true);
  });

  it('gives each new key its own bucket when the table is full, so none starves another', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (const k of ['k1', 'k2', 'k3']) for (let i = 0; i < 5; i++) rl.check(k, 1000);
    const n1 = Array.from({ length: 6 }, () => rl.check('n1', 1000));
    expect(n1).toEqual([true, true, true, true, true, false]);
    expect(rl.check('n2', 1000)).toBe(true);
  });

  it('evicts the least-recently-used key at maxKeys, not the one that was asking', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 3 });
    for (let i = 0; i < 4; i++) rl.check('idle', 1000);
    for (let i = 0; i < 5; i++) rl.check('busy', 1000);
    rl.check('other', 1000);
    rl.check('n1', 1000);
    expect(rl.check('busy', 1000)).toBe(false);
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
    for (let i = 0; i < 4; i++) rl.check('spending', 1000);
    rl.check('refilled', 1000);
    rl.check('later', 1000);
    rl.check('new', 1100);
    expect(Array.from({ length: 3 }, () => rl.check('spending', 1100))).toEqual([true, true, false]);
  });

  it('reads at most 64 buckets to free a slot for an unseen key at 10,000 keys, then drops the oldest', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 10_000 });
    for (let k = 0; k < 10_000; k++) for (let i = 0; i < 5; i++) rl.check(`drained-${k}`, 1000);
    // Every walk of a Map steps this one iterator method, so its calls count the buckets a check reads in turn.
    const mapIterator: Iterator<unknown> = Object.getPrototypeOf(new Map().keys());
    const steps = vi.spyOn(mapIterator, 'next');
    try {
      expect(rl.check('new', 1000)).toBe(true);
      expect(steps.mock.calls.length).toBeLessThanOrEqual(64);
    } finally {
      steps.mockRestore();
    }
    expect([rl.check('drained-1', 1000), rl.check('drained-0', 1000)]).toEqual([false, true]);
  });

  it('drops the oldest bucket only when every bucket is throttled', () => {
    const rl = createRateLimiter({ ...OPTS, maxKeys: 2 });
    for (const k of ['first', 'second']) for (let i = 0; i < 5; i++) rl.check(k, 1000);
    rl.check('new', 1000);
    expect(rl.check('second', 1000)).toBe(false);
    expect(rl.check('first', 1000)).toBe(true);
  });
});
