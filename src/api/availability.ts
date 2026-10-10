import { DAY_MS } from '../util/time.js';
// Flags when a recall's top-K is dominated by recent entries while older relevant candidates in the same matched pool were passed over.
// Soft warning only (never filters or reorders) and PURE: no I/O or env reads; the HIPPO_AVAILABILITY gate lives in the callers.

/** A minimal age reference: a memory id plus its ISO-8601 creation timestamp
 *  (MemoryEntry.created, canonical ISO per the src/core/memory.ts invariant). */
export interface AgeRef {
  id: string;
  created: string;
}

export interface AvailabilityHint {
  /** Count of returned top-K entries created within the recency window. */
  recentCount: number;
  /** Total returned top-K size considered (after dropping unparseable rows). */
  returnedCount: number;
  /** recentCount / returnedCount, in [0, 1]. */
  recentFraction: number;
  /** Median age in days of the returned top-K. */
  topKMedianAgeDays: number;
  /** Median age in days of the matched candidate pool it was drawn from. */
  poolMedianAgeDays: number;
  /** Count of pool entries older than the top-K median age that were NOT
   *  returned (older relevant matches passed over). */
  olderCandidatesPassedOver: number;
  /** Human-readable summary surfaced to the agent. */
  summary: string;
  /** Discriminator for hint origin; reserved for future variants. */
  source: 'j2-recency';
}

export interface DetectAvailabilityBiasOpts {
  /** The returned matched results (the top-K the agent will see). */
  topK: readonly AgeRef[];
  /** The full matched candidate pool the top-K was drawn from. */
  pool: readonly AgeRef[];
  /** Reference "now" in epoch ms. Defaults to Date.now(). */
  now?: number;
  /** Recency window in ms; entries newer than this count as "recent". Default 24h. */
  recencyWindowMs?: number;
  /** Minimum recent fraction (exclusive) required to fire. Default 0.7 (>70%). */
  recentFractionThreshold?: number;
  /** Minimum returned size required to fire. Default 3. */
  minReturned?: number;
  /** Minimum pool size required to fire. Default 10. */
  minPool?: number;
  /** Minimum older-passed-over count required to fire. Default 3. */
  minOlderPassedOver?: number;
}

export const DEFAULT_RECENCY_WINDOW_MS = DAY_MS;
export const DEFAULT_RECENT_FRACTION_THRESHOLD = 0.7;
export const DEFAULT_MIN_RETURNED = 3;
export const DEFAULT_MIN_POOL = 10;
export const DEFAULT_MIN_OLDER_PASSED_OVER = 3;

const MS_PER_HOUR = 60 * 60 * 1000;

function median(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function parseTimestamps(refs: readonly AgeRef[]): { id: string; ts: number }[] {
  return refs
    .map((e) => ({ id: e.id, ts: Date.parse(e.created) }))
    .filter((e) => Number.isFinite(e.ts));
}

/** Returns an AvailabilityHint when the returned slice is recency-dominated, the pool skews older and older matches were passed over; else null.
 * Entries with an unparseable `created` are dropped so a malformed row cannot poison the medians with NaN. */
export function detectAvailabilityBias(opts: DetectAvailabilityBiasOpts): AvailabilityHint | null {
  const now = opts.now ?? Date.now();
  const recencyWindowMs = opts.recencyWindowMs ?? DEFAULT_RECENCY_WINDOW_MS;
  const recentFractionThreshold =
    opts.recentFractionThreshold ?? DEFAULT_RECENT_FRACTION_THRESHOLD;
  const minReturned = opts.minReturned ?? DEFAULT_MIN_RETURNED;
  const minPool = opts.minPool ?? DEFAULT_MIN_POOL;
  const minOlderPassedOver = opts.minOlderPassedOver ?? DEFAULT_MIN_OLDER_PASSED_OVER;

  const topK = parseTimestamps(opts.topK);
  const pool = parseTimestamps(opts.pool);

  if (topK.length < minReturned || pool.length < minPool) return null;

  const recentCount = topK.filter((e) => now - e.ts <= recencyWindowMs).length;
  const recentFraction = recentCount / topK.length;
  if (recentFraction <= recentFractionThreshold) return null;

  const topKMedianAgeDays = median(topK.map((e) => (now - e.ts) / DAY_MS));
  const poolMedianAgeDays = median(pool.map((e) => (now - e.ts) / DAY_MS));
  if (poolMedianAgeDays <= topKMedianAgeDays) return null;

  const topKIds = new Set(topK.map((e) => e.id));
  const olderCandidatesPassedOver = pool.filter(
    (e) => !topKIds.has(e.id) && (now - e.ts) / DAY_MS > topKMedianAgeDays,
  ).length;
  if (olderCandidatesPassedOver < minOlderPassedOver) return null;

  const pct = Math.round(recentFraction * 100);
  const windowHours = Math.round(recencyWindowMs / MS_PER_HOUR);
  const summary =
    `Availability bias risk: ${recentCount} of ${topK.length} returned results are from the ` +
    `last ${windowHours}h (${pct}%), but ${olderCandidatesPassedOver} older matched memories ` +
    `were passed over. Returned median age ${topKMedianAgeDays.toFixed(1)}d vs pool median ` +
    `${poolMedianAgeDays.toFixed(1)}d. The most relevant answer may not be the most recent.`;

  return {
    recentCount,
    returnedCount: topK.length,
    recentFraction,
    topKMedianAgeDays,
    poolMedianAgeDays,
    olderCandidatesPassedOver,
    summary,
    source: 'j2-recency',
  };
}
