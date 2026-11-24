/**
 * Per-key token-bucket rate limiter for inbound /v1/* requests, bounding api-key-id enumeration.
 * Dependency-free; the injectable `now` makes it unit-testable. */

/** Key cap for every serve() bucket, shared by the warn map so it never tracks more callers than
 * the buckets do. */
export const LIMITER_MAX_KEYS = 10_000;

export interface RateLimiter {
  check(key: string, now?: number): boolean;
  readonly retryAfterSec: number;
}

export interface RateLimiterOptions {
  ratePerSec: number;
  burst: number;
  idleEvictMs: number;
  maxKeys: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

interface RefillOptions {
  now: number;
  ratePerSec: number;
  burst: number;
}

function tokensAt(b: Bucket, { now, ratePerSec, burst }: RefillOptions): number {
  return Math.min(burst, b.tokens + (Math.max(0, now - b.last) / 1000) * ratePerSec);
}

function refill(b: Bucket, at: RefillOptions): Bucket {
  b.tokens = tokensAt(b, at);
  b.last = Math.max(b.last, at.now);
  return b;
}

function spend(b: Bucket): boolean {
  const allowed = b.tokens >= 1;
  if (allowed) b.tokens -= 1;
  return allowed;
}

const EVICTION_SCAN = 64;

function makeRoom(buckets: Map<string, Bucket>, now: number, opts: RateLimiterOptions): void {
  if (buckets.size < opts.maxKeys) return;
  let spendable: string | undefined;
  let oldest: string | undefined;
  let read = 0;
  for (const [key, b] of buckets) {
    oldest ??= key;
    const tokens = tokensAt(b, { now, ratePerSec: opts.ratePerSec, burst: opts.burst });
    if (tokens >= opts.burst) {
      buckets.delete(key);
      return;
    }
    if (tokens >= 1) spendable ??= key;
    if (++read >= EVICTION_SCAN) break;
  }
  const victim = spendable ?? oldest;
  if (victim !== undefined) buckets.delete(victim);
}

/** Token-bucket limiter with bounded memory: an idle sweep at most once per `idleEvictMs`, and a
 * `maxKeys` cap. A flood of new keys cannot reset a throttled caller unless the EVICTION_SCAN
 * oldest buckets are all throttled. */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { ratePerSec, burst, idleEvictMs } = opts;
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
        // Re-inserting puts the key last in Map iteration order, so Map order tracks
        // least-recently-used.
        buckets.delete(key);
        buckets.set(key, existing);
        return spend(refill(existing, { now, ratePerSec, burst }));
      }
      makeRoom(buckets, now, opts);
      const bucket: Bucket = { tokens: burst, last: now };
      buckets.set(key, bucket);
      return spend(bucket);
    },
    retryAfterSec: Math.max(1, Math.ceil(1 / ratePerSec)),
  };
}
