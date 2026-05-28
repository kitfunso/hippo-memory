// ---------------------------------------------------------------------------
// J2 — Availability-bias detector (Track J: biases-over-memory-state)
// ---------------------------------------------------------------------------
//
// Flags when a recall's returned top-K is dominated by recent entries while
// substantially older relevant candidates in the same MATCHED pool were passed
// over. This is the availability / recency heuristic (Tversky-Kahneman): what
// is most mentally available (recent) gets over-weighted relative to what is
// most relevant. Hippo's substrate makes this measurable: every entry carries a
// creation timestamp, so we can compare the age distribution of what was
// RETURNED against the age distribution of the pool it was drawn from.
//
// Soft warning ONLY (ROADMAP-RESEARCH.md Track J discipline note): this never
// filters, reorders, or suppresses a result. It surfaces a hint the calling
// agent may choose to act on, exactly like J1 anchoringHint / J3
// planningFallacyHint / C5 suppressionSummary.
//
// PURE: no I/O, no env reads. The env gate (HIPPO_AVAILABILITY=off) and the
// audit emission live in the callers (api.recall, cmdRecall, MCP), mirroring
// detectAnchoring in recall-history.ts.

/** A minimal age reference: a memory id plus its ISO-8601 creation timestamp
 *  (MemoryEntry.created, canonical ISO per the src/memory.ts invariant). */
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

export const DEFAULT_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RECENT_FRACTION_THRESHOLD = 0.7;
export const DEFAULT_MIN_RETURNED = 3;
export const DEFAULT_MIN_POOL = 10;
export const DEFAULT_MIN_OLDER_PASSED_OVER = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

function median(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Detect availability/recency bias in a recall result.
 *
 * Returns an AvailabilityHint when ALL of the following hold:
 *   1. topK.length >= minReturned AND pool.length >= minPool (enough signal);
 *   2. recentFraction > recentFractionThreshold (returned slice is recency-dominated);
 *   3. poolMedianAgeDays > topKMedianAgeDays (the pool genuinely skews older,
 *      so recency is not just the corpus being young);
 *   4. olderCandidatesPassedOver >= minOlderPassedOver (older matched memories
 *      actually existed and were not returned).
 * Otherwise returns null.
 *
 * Entries with an unparseable `created` are dropped defensively so a malformed
 * row cannot poison the medians with NaN.
 */
export function detectAvailabilityBias(opts: DetectAvailabilityBiasOpts): AvailabilityHint | null {
  const now = opts.now ?? Date.now();
  const recencyWindowMs = opts.recencyWindowMs ?? DEFAULT_RECENCY_WINDOW_MS;
  const recentFractionThreshold =
    opts.recentFractionThreshold ?? DEFAULT_RECENT_FRACTION_THRESHOLD;
  const minReturned = opts.minReturned ?? DEFAULT_MIN_RETURNED;
  const minPool = opts.minPool ?? DEFAULT_MIN_POOL;
  const minOlderPassedOver = opts.minOlderPassedOver ?? DEFAULT_MIN_OLDER_PASSED_OVER;

  const topK = opts.topK
    .map((e) => ({ id: e.id, ts: Date.parse(e.created) }))
    .filter((e) => Number.isFinite(e.ts));
  const pool = opts.pool
    .map((e) => ({ id: e.id, ts: Date.parse(e.created) }))
    .filter((e) => Number.isFinite(e.ts));

  if (topK.length < minReturned || pool.length < minPool) return null;

  const recentCount = topK.filter((e) => now - e.ts <= recencyWindowMs).length;
  const recentFraction = recentCount / topK.length;
  if (recentFraction <= recentFractionThreshold) return null;

  const topKMedianAgeDays = median(topK.map((e) => (now - e.ts) / MS_PER_DAY));
  const poolMedianAgeDays = median(pool.map((e) => (now - e.ts) / MS_PER_DAY));
  if (poolMedianAgeDays <= topKMedianAgeDays) return null;

  const topKIds = new Set(topK.map((e) => e.id));
  const olderCandidatesPassedOver = pool.filter(
    (e) => !topKIds.has(e.id) && (now - e.ts) / MS_PER_DAY > topKMedianAgeDays,
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
