/**
 * Per-key token-bucket rate limiter for inbound /v1/* requests, bounding api-key-id enumeration. Dependency-free; the
 * injectable `now` makes it unit-testable. */

export interface RateLimiter {
  /**
   * Consume one token for `key`: true if allowed, false if the bucket is exhausted; `now` (epoch ms) is injectable for
   * deterministic tests.
   */
  check(key: string, now?: number): boolean;
  readonly retryAfterSec: number;
}

export interface RateLimiterOptions {
  /** Sustained refill rate in tokens per second. */
  ratePerSec: number;
  /** Bucket capacity — the largest burst a fresh client may spend at once. */
  burst: number;
  /** A bucket untouched for this many ms is dropped by the throttled sweep. */
  idleEvictMs: number;
  /** Hard cap on tracked keys; at the cap an unseen key replaces a refilled bucket, else one that can still spend. */
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

/** Frees one slot: the oldest bucket that has refilled to full, else the oldest that can still spend, else (every
 * bucket is throttled) the oldest. A throttled caller therefore keeps its bucket while others can be dropped. */
function makeRoom(buckets: Map<string, Bucket>, now: number, opts: RateLimiterOptions): void {
  if (buckets.size < opts.maxKeys) return;
  let spendable: string | undefined;
  let oldest: string | undefined;
  for (const [key, b] of buckets) {
    oldest ??= key;
    const tokens = tokensAt(b, now, opts.ratePerSec, opts.burst);
    if (tokens >= opts.burst) {
      buckets.delete(key);
      return;
    }
    if (tokens >= 1) spendable ??= key;
  }
  const victim = spendable ?? oldest;
  if (victim !== undefined) buckets.delete(victim);
}

/**
 * Token-bucket limiter with bounded memory: a sweep (at most once per `idleEvictMs`) drops idle buckets and a `maxKeys`
 * cap bounds the map. At the cap a full bucket goes first and a throttled one stays, so a flood of new keys cannot
 * reset a throttled caller unless every tracked key is throttled.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { ratePerSec, burst, idleEvictMs } = opts;
  // Every request reaches these buckets because serve() holds the store's pidfile lock (claimPidfile).
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
      if (existing !== undefined) {
        // Re-inserting puts the key last in Map iteration order, so Map order tracks least-recently-used.
        buckets.delete(key);
        buckets.set(key, existing);
        return spend(refill(existing, now, ratePerSec, burst));
      }
      makeRoom(buckets, now, opts);
      // Unseen key: a full bucket, so a fresh client's first request passes.
      const bucket: Bucket = { tokens: burst, last: now };
      buckets.set(key, bucket);
      return spend(bucket);
    },
    // A refused bucket holds under one token and refills at ratePerSec, so one token is back within this.
    retryAfterSec: Math.max(1, Math.ceil(1 / ratePerSec)),
  };
}
