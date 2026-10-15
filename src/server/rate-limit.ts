/**
 * Per-key token-bucket rate limiter for inbound /v1/* requests, bounding api-key-id enumeration. Dependency-free; the
 * injectable `now` makes it
 * unit-testable. */

export interface RateLimiter {
  /**
   * Consume one token for `key`: true if allowed, false if the bucket is exhausted; `now` (epoch ms) is injectable for
   * deterministic tests.
   */
  check(key: string, now?: number): boolean;
  readonly retryAfterSec: number;
}

export interface RateLimiterOpts {
  /** Sustained refill rate in tokens per second. */
  ratePerSec: number;
  /** Bucket capacity — the largest burst a fresh client may spend at once. */
  burst: number;
  /** A bucket untouched for this many ms is dropped by the throttled sweep. */
  idleEvictMs: number;
  /**
   * Hard cap on tracked keys; at the cap the least-recently-used key is evicted only once it has refilled, else unseen
   * keys share one overflow bucket.
   */
  maxKeys: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

/** The tokens `b` holds at `now`; a clock stepped back refills nothing. */
function tokensAt(b: Bucket, now: number, ratePerSec: number, burst: number): number {
  return Math.min(burst, b.tokens + (Math.max(0, now - b.last) / 1000) * ratePerSec);
}

/**
 * Brings `b` up to `now` and returns it; keeping the later time stops a clock that stepped back and forward again
 * refilling that span twice.
 */
function refill(b: Bucket, now: number, ratePerSec: number, burst: number): Bucket {
  b.tokens = tokensAt(b, now, ratePerSec, burst);
  b.last = Math.max(b.last, now);
  return b;
}

function spend(b: Bucket): boolean {
  const allowed = b.tokens >= 1;
  if (allowed) b.tokens -= 1;
  return allowed;
}

/**
 * Token-bucket limiter with bounded memory: a sweep (at most once per `idleEvictMs`) drops idle buckets and a `maxKeys`
 * cap bounds the map,
 * so a client rotating source addresses can neither grow it without bound nor evict its own throttled bucket to get a
 * fresh one.
 */
export function createRateLimiter(opts: RateLimiterOpts): RateLimiter {
  const { ratePerSec, burst, idleEvictMs, maxKeys } = opts;
  // SHORTCUT: one process, buckets reset on restart; a shared store table if the server runs as several processes.
  const buckets = new Map<string, Bucket>();
  // Unseen keys draw from this while the map is full of buckets still below burst, so key churn buys no fresh bucket.
  const overflow: Bucket = { tokens: burst, last: 0 };
  let lastSweep = 0;

  function sweep(now: number): void {
    if (now - lastSweep < idleEvictMs) return;
    lastSweep = now;
    for (const [key, b] of buckets) {
      if (now - b.last >= idleEvictMs) buckets.delete(key);
    }
  }

  /**
   * Frees one slot for an unseen key; false when the least-recently-used bucket is still below burst, since dropping it
   * would reset a throttled caller.
   */
  function makeRoom(now: number): boolean {
    if (buckets.size < maxKeys) return true;
    const lru = buckets.entries().next().value;
    if (lru === undefined) return true;
    if (tokensAt(lru[1], now, ratePerSec, burst) < burst) return false;
    buckets.delete(lru[0]);
    return true;
  }

  return {
    check(key: string, now: number = Date.now()): boolean {
      sweep(now);

      const existing = buckets.get(key);
      if (existing !== undefined) {
        // Re-inserting puts the key last in Map iteration order, so Map order tracks least-recently-used.
        buckets.delete(key);
        buckets.set(key, existing);
        return spend(refill(existing, now, ratePerSec, burst));
      }
      if (!makeRoom(now)) return spend(refill(overflow, now, ratePerSec, burst));
      // Unseen key: a full bucket, so a fresh client's first request passes.
      const bucket: Bucket = { tokens: burst, last: now };
      buckets.set(key, bucket);
      return spend(bucket);
    },
    // A refused bucket holds under one token and refills at ratePerSec, so one token is back within this.
    retryAfterSec: Math.max(1, Math.ceil(1 / ratePerSec)),
  };
}
