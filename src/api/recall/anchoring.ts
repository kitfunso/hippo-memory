// The anchoring detector and the bias-hint switch.
import type { HippoConfig } from '../../base/config/config.js';
import { fnv1a32 } from '../../base/util/fnv1a.js';

/**
 * Anchoring detector (recall-recurrence), pure module: `query_repeat` (a queryHash re-asked
 * within the window returns the same topMemoryId) and `memory_dominance` (the same topMemoryId
 * across >= minDominance distinct queryHashes). Each pipeline keeps its OWN ring Map keyed by
 * (tenant, session), because its top-1 ranking differs. AnchoringHint and PlanningFallacyHint
 * are independent signals. */

export type AnchoringReason = 'query_repeat' | 'memory_dominance';

export interface AnchoringHint {
  reason: AnchoringReason;
  /** The memory ID that is anchoring the agent's reasoning. */
  memoryId: string;
  /** For 'memory_dominance': how many distinct queries in the recent window had this memory as their top-1 result.
   *  Always at least `minDominance` when emitted. */
  queryCount?: number;
  /** Human-readable summary surfaced to the agent. */
  summary: string;
  /** Discriminator for hint origin; reserved for future variants. */
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
  /** memory_dominance threshold: number of distinct queryHashes that must have returned the same topMemoryId. Default
   *  DEFAULT_MIN_DOMINANCE. */
  minDominance?: number;
  /** query_repeat window: how many recent history entries to scan for query repeat.
   *  Default DEFAULT_RECENT_REPEAT_WINDOW. */
  recentRepeatWindow?: number;
  /**
   * Cooldown: suppress when the prior fire (per `anchoredOn`) was for the same topMemoryId within
   * this many history entries. Default DEFAULT_COOLDOWN.
   */
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
  // Tokens are deduped before join so `foo foo bar` and `foo bar` count as one query for
  // memory_dominance. Unicode classes (\p{L}, \p{N}, \p{M}; need /u) keep non-Latin queries from
  // collapsing to an empty token set and colliding at hash 0.
  const normalized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  // Drop tokens under 3 chars (filler words) so `a login bug` and `login bug` hash alike; matches
  // the >=3 filter in src/domain/learn/forward-claim-detector.ts.
  const filtered = normalized.filter((t) => t.length >= 3);
  // Fall back to all tokens when the filter empties the query (CJK 2-char words, acronyms like
  // `AI`) so distinct short queries do not all hash to fnv1a32('').
  const tokens = filtered.length > 0 ? filtered : normalized;
  const deduped = Array.from(new Set(tokens)).sort();
  return fnv1a32(deduped.join(' '));
}

/**
 * Detects anchoring against the current (queryHash, topMemoryId); memory_dominance wins when both
 * rules fire, since it spans DIFFERENT queries. Cooldown is per memory: a hint on the SAME
 * topMemoryId within `cooldown` history entries (DEFAULT_COOLDOWN by default) is suppressed.
 * Returns an AnchoringHint or null.
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

  // Cooldown gate: was the most-recent hint (across the last `cooldown` entries) for THIS memory?
  // If yes, suppress regardless of rule.
  if (onCooldown(history, cooldown, currentTopMemoryId)) return null;

  // memory_dominance check FIRST (wins on tie).
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

// Count distinct queryHashes in history where topMemoryId === the current top (excluding null
// tops), plus the current query itself.
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

// query_repeat check: is currentQueryHash present in the last `recentRepeatWindow` entries AND was
// that entry's topMemoryId === currentTopMemoryId?
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
