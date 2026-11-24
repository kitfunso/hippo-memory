import type { HippoConfig } from '../../base/config/config.js';

/**
 * Anchoring detector (recall-recurrence), pure module: `query_repeat` (a queryHash re-asked
 * within the window returns the same topMemoryId) and `memory_dominance` (the same topMemoryId
 * across >= minDominance distinct queryHashes). Each pipeline keeps its OWN ring Map keyed by
 * (tenant, session), because its top-1 ranking differs. AnchoringHint and PlanningFallacyHint
 * are independent signals. */

export type AnchoringReason = 'query_repeat' | 'memory_dominance';

export interface AnchoringHint {
  reason: AnchoringReason;
  memoryId: string;
  queryCount?: number;
  summary: string;
  source: 'j1-recurrence';
}

export interface RecallHistoryEntry {
  /** Hash of the queryText that produced this entry (see hashQueryText). */
  queryHash: number;
  /** Top-1 memory id this recall surfaced; null if zero results. */
  topMemoryId: string | null;
  /** ISO-8601 timestamp; advisory, not used by the detection rules. */
  ts: string;
  /**
   * Memory id of the AnchoringHint that fired on this recall, if any; the caller writes it after
   * detectAnchoring returns, and the cooldown reads it next time. */
  anchoredOn?: string;
}

export type RecallHistorySnapshot = readonly RecallHistoryEntry[];

export interface DetectAnchoringOptions {
  minDominance?: number;
  recentRepeatWindow?: number;
  cooldown?: number;
}

const DEFAULT_MIN_DOMINANCE = 3;
const DEFAULT_RECENT_REPEAT_WINDOW = 5;
const DEFAULT_COOLDOWN = 3;

/**
 * Normalizes a query (lowercase, strip non-alphanumerics, drop short tokens, sort, dedup, join)
 * and hashes it with 32-bit FNV-1a. Reordered words collide intentionally; deterministic across
 * processes and V8 versions. */
export function hashQueryText(query: string): number {
  if (!query) return 0;
  const normalized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const filtered = normalized.filter((t) => t.length >= 3);
  const tokens = filtered.length > 0 ? filtered : normalized;
  const deduped = Array.from(new Set(tokens)).sort();
  return fnv1a32(deduped.join(' '));
}

function fnv1a32(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Detects anchoring against the current (queryHash, topMemoryId); memory_dominance wins when both
 * rules fire, since it spans DIFFERENT queries. Cooldown is per memory: a hint on the SAME
 * topMemoryId within `cooldown=3` history entries is suppressed. Returns an AnchoringHint or null.
 */
export function detectAnchoring(
  history: RecallHistorySnapshot,
  currentQueryHash: number,
  currentTopMemoryId: string | null,
  opts: DetectAnchoringOptions = {},
): AnchoringHint | null {
  if (currentTopMemoryId === null) return null;
  const minDominance = opts.minDominance ?? DEFAULT_MIN_DOMINANCE;
  const recentRepeatWindow = opts.recentRepeatWindow ?? DEFAULT_RECENT_REPEAT_WINDOW;
  const cooldown = opts.cooldown ?? DEFAULT_COOLDOWN;

  if (onCooldown(history, cooldown, currentTopMemoryId)) return null;

  const queryCount = countDistinctQueries(history, currentQueryHash, currentTopMemoryId);
  if (queryCount >= minDominance) {
    return {
      reason: 'memory_dominance',
      memoryId: currentTopMemoryId,
      queryCount,
      summary:
        `Memory ${currentTopMemoryId} has been the top result for ${queryCount} distinct queries in this ` +
        `session and may be anchoring your reasoning.`,
      source: 'j1-recurrence',
    };
  }

  if (isRecentRepeat(history, recentRepeatWindow, currentQueryHash, currentTopMemoryId)) {
    return queryRepeatHint(currentTopMemoryId);
  }

  return null;
}

function onCooldown(history: RecallHistorySnapshot, cooldown: number, memoryId: string): boolean {
  for (const entry of history.slice(-cooldown)) {
    if (entry.anchoredOn === memoryId) return true;
  }
  return false;
}

function queryRepeatHint(memoryId: string): AnchoringHint {
  return {
    reason: 'query_repeat',
    memoryId,
    summary:
      `Same query phrasing as a recent recall returned the same top result (${memoryId}); you may ` +
      `be re-asking the same question.`,
    source: 'j1-recurrence',
  };
}

function countDistinctQueries(
  history: RecallHistorySnapshot,
  currentQueryHash: number,
  currentTopMemoryId: string,
): number {
  const matchingQueryHashes = new Set<number>();
  for (const entry of history) {
    if (entry.topMemoryId === currentTopMemoryId) {
      matchingQueryHashes.add(entry.queryHash);
    }
  }
  matchingQueryHashes.add(currentQueryHash);
  return matchingQueryHashes.size;
}

function isRecentRepeat(
  history: RecallHistorySnapshot,
  recentRepeatWindow: number,
  currentQueryHash: number,
  currentTopMemoryId: string,
): boolean {
  return history
    .slice(-recentRepeatWindow)
    .some(
      (entry) => entry.queryHash === currentQueryHash && entry.topMemoryId === currentTopMemoryId,
    );
}

/** The part of a config the hint switches read. */
export type HintConfig = Pick<HippoConfig, 'runtime'>;

/** Whether a recall bias hint is on: `HIPPO_ANCHORING=off` or `HIPPO_AVAILABILITY=off`, as the
 * root read it into the config, turns off only that kind. */
export function biasHintEnabled(config: HintConfig, kind: 'anchoring' | 'availability'): boolean {
  const on =
    kind === 'anchoring' ? config.runtime?.anchoringHint : config.runtime?.availabilityHint;
  return on !== false;
}
