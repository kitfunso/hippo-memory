/**
 * Per-key token-bucket rate limiter for inbound /v1/* requests, bounding api-key-id enumeration. Dependency-free; the
 * injectable `now` makes it unit-testable. */
import { MinHeap } from '../../base/util/min-heap.js';

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
  /** Its latest use; an index entry for an earlier one is stale. */
  seq: number;
}

/** One use of a bucket, with the times its tokens reach one and the burst again if nothing spends them. */
interface Use {
  readonly key: string;
  readonly seq: number;
  readonly spendableAt: number;
  readonly fullAt: number;
}

// Stale uses an index may hold beyond twice the table before it drops them.
const INDEX_SLACK = 64;

/** The tokens `b` holds at `now`; a clock stepped back refills nothing. */
function tokensAt(b: Bucket, now: number, ratePerSec: number, burst: number): number {
  return Math.min(burst, b.tokens + (Math.max(0, now - b.last) / 1000) * ratePerSec);
}

/** When `b`, left alone, holds `level` tokens: at once if it already does. */
function reachesAt(b: Bucket, level: number, msPerToken: number): number {
  return b.tokens >= level ? -Infinity : b.last + (level - b.tokens) * msPerToken;
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

/** The buckets whose latest use has reached a level by now, least recently used first. A use waits under the time it
 * gets there, then queues in use order, so finding the oldest never walks the table. */
class LevelIndex {
  private readonly waiting: MinHeap<Use>;
  private readonly reached = new MinHeap<Use>((use) => use.seq);

  constructor(private readonly at: (use: Use) => number) {
    this.waiting = new MinHeap(at);
  }

  file(use: Use, tableSize: number, current: (use: Use) => boolean): void {
    this.waiting.push(use);
    // Each use leaves the bucket's earlier entry stale, so memory follows the table, not the request count.
    if (this.waiting.size + this.reached.size > 2 * tableSize + INDEX_SLACK) {
      this.waiting.retain(current);
      this.reached.retain(current);
    }
  }

  oldest(now: number, current: (use: Use) => boolean): string | undefined {
    for (let use = this.waiting.peek(); use !== undefined && this.at(use) <= now; use = this.waiting.peek()) {
      this.waiting.pop();
      if (current(use)) this.reached.push(use);
    }
    for (let use = this.reached.peek(); use !== undefined; use = this.reached.peek()) {
      if (current(use)) return use.key;
      this.reached.pop();
    }
    return undefined;
  }
}

/** Which bucket goes at the cap: the oldest that has refilled to full, else the oldest that can still spend, else
 * (every bucket is throttled) the oldest. A throttled caller therefore keeps its bucket while others can be dropped. */
class EvictionOrder {
  private readonly full = new LevelIndex((use) => use.fullAt);
  private readonly spendable = new LevelIndex((use) => use.spendableAt);
  private seq = 0;

  constructor(
    private readonly buckets: Map<string, Bucket>,
    private readonly burst: number,
    private readonly msPerToken: number,
  ) {}

  private readonly current = (use: Use): boolean => this.buckets.get(use.key)?.seq === use.seq;

  /** Records a use of `b`, which the caller has just moved to the back of the table. */
  file(key: string, b: Bucket): void {
    b.seq = ++this.seq;
    const spendableAt = reachesAt(b, 1, this.msPerToken);
    const use = { key, seq: b.seq, spendableAt, fullAt: reachesAt(b, this.burst, this.msPerToken) };
    this.full.file(use, this.buckets.size, this.current);
    this.spendable.file(use, this.buckets.size, this.current);
  }

  victim(now: number): string | undefined {
    const { full, spendable, current } = this;
    return full.oldest(now, current) ?? spendable.oldest(now, current) ?? this.buckets.keys().next().value;
  }
}

/**
 * Token-bucket limiter with bounded memory: a sweep (at most once per `idleEvictMs`) drops idle buckets and a `maxKeys`
 * cap bounds the map. At the cap a full bucket goes first and a throttled one stays, so a flood of new keys cannot
 * reset a throttled caller unless every tracked key is throttled.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { ratePerSec, burst, idleEvictMs, maxKeys } = opts;
  // Every request reaches these buckets because serve() holds the store's pidfile lock (claimPidfile).
  const buckets = new Map<string, Bucket>();
  const order = new EvictionOrder(buckets, burst, 1000 / ratePerSec);
  let lastSweep = 0;

  function sweep(now: number): void {
    if (now - lastSweep < idleEvictMs) return;
    lastSweep = now;
    for (const [key, b] of buckets) {
      if (now - b.last >= idleEvictMs) buckets.delete(key);
    }
  }

  /** Spends from `b`; re-inserting puts the key last in Map order, so that order is least recent use. */
  function use(key: string, b: Bucket): boolean {
    const allowed = spend(b);
    buckets.delete(key);
    buckets.set(key, b);
    order.file(key, b);
    return allowed;
  }

  return {
    check(key: string, now: number = Date.now()): boolean {
      sweep(now);
      const existing = buckets.get(key);
      if (existing !== undefined) return use(key, refill(existing, now, ratePerSec, burst));
      const victim = buckets.size >= maxKeys ? order.victim(now) : undefined;
      if (victim !== undefined) buckets.delete(victim);
      // Unseen key: a full bucket, so a fresh client's first request passes.
      return use(key, { tokens: burst, last: now, seq: 0 });
    },
    // A refused bucket holds under one token and refills at ratePerSec, so one token is back within this.
    retryAfterSec: Math.max(1, Math.ceil(1 / ratePerSec)),
  };
}
