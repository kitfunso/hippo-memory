/**
 * Per-key token-bucket rate limiter for inbound /v1/* requests.
 *
 * Bounds api-key-id enumeration (the v0.40 follow-up noted in auth.ts): a
 * client that drains its bucket is denied until it refills. Dependency-free
 * and unit-testable in isolation via the injectable `now`.
 */

export interface RateLimiter {
  /**
   * Consume one token for `key`. Returns true if the request is allowed,
   * false if the key's bucket is exhausted. `now` (epoch ms) is injectable
   * for deterministic tests.
   */
  check(key: string, now?: number): boolean;
}

export interface RateLimiterOpts {
  /** Sustained refill rate in tokens per second. */
  ratePerSec: number;
  /** Bucket capacity — the largest burst a fresh client may spend at once. */
  burst: number;
  /** A bucket untouched for this many ms is dropped by the throttled sweep. */
  idleEvictMs: number;
  /** Hard cap on tracked keys; the least-recently-used key is evicted on overflow. */
  maxKeys: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

/**
 * Build a token-bucket limiter. Memory is bounded two ways: a sweep (throttled
 * to once per `idleEvictMs`) drops idle buckets, and a hard `maxKeys` cap evicts
 * the least-recently-used key, so a client rotating source addresses cannot
 * grow the map without bound between sweeps.
 */
export function createRateLimiter(opts: RateLimiterOpts): RateLimiter {
  const { ratePerSec, burst, idleEvictMs, maxKeys } = opts;
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  function sweep(now: number): void {
    if (now - lastSweep < idleEvictMs) return;
    lastSweep = now;
    for (const [key, b] of buckets) {
      if (now - b.last >= idleEvictMs) buckets.delete(key);
    }
  }

  return {
    check(key: string, now: number = Date.now()): boolean {
      sweep(now);

      const existing = buckets.get(key);
      let bucket: Bucket;
      if (existing === undefined) {
        // Unseen key: a full bucket, so a fresh client's first request passes.
        bucket = { tokens: burst, last: now };
      } else {
        // Refill for elapsed time, capped at burst.
        const refill = ((now - existing.last) / 1000) * ratePerSec;
        existing.tokens = Math.min(burst, existing.tokens + refill);
        existing.last = now;
        bucket = existing;
        // Drop the old slot so the re-insert below puts the key last in Map
        // iteration order — Map order then tracks least-recently-used.
        buckets.delete(key);
      }

      const allowed = bucket.tokens >= 1;
      if (allowed) bucket.tokens -= 1;

      // Hard cap: evict the LRU key (first in iteration order) before inserting.
      if (buckets.size >= maxKeys) {
        const lru = buckets.keys().next().value;
        if (lru !== undefined) buckets.delete(lru);
      }
      buckets.set(key, bucket);

      return allowed;
    },
  };
}
