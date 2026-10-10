/** Anchoring detector (recall-recurrence), pure module: `query_repeat` (a queryHash re-asked within the window returns the same topMemoryId) and
 * `memory_dominance` (the same topMemoryId across >= minDominance distinct queryHashes). Each pipeline keeps its OWN ring Map keyed by (tenant, session),
 * because its top-1 ranking differs. AnchoringHint and PlanningFallacyHint are independent signals. */

import { envAnchoringOff, envAvailabilityOff } from '../util/env.js';

export type AnchoringReason = 'query_repeat' | 'memory_dominance';

export interface AnchoringHint {
  reason: AnchoringReason;
  /** The memory ID that is anchoring the agent's reasoning. */
  memoryId: string;
  /** For 'memory_dominance': how many distinct queries in the recent window
   *  had this memory as their top-1 result. Always >= 3 when emitted. */
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
  /** Memory id of the AnchoringHint that fired on this recall, if any; the caller writes it after detectAnchoring returns, and the cooldown reads it next
   * time. */
  anchoredOn?: string;
}

export type RecallHistorySnapshot = readonly RecallHistoryEntry[];

export interface DetectAnchoringOpts {
  /** memory_dominance threshold: number of distinct queryHashes that must have returned
   *  the same topMemoryId. Default 3. */
  minDominance?: number;
  /** query_repeat window: how many recent history entries to scan for query repeat.
   *  Default 5. */
  recentRepeatWindow?: number;
  /** Cooldown: suppress when the prior fire (per `anchoredOn`) was for the same topMemoryId within this many history entries. Default 3. */
  cooldown?: number;
}

const DEFAULT_MIN_DOMINANCE = 3;
const DEFAULT_RECENT_REPEAT_WINDOW = 5;
const DEFAULT_COOLDOWN = 3;

/** Normalizes a query (lowercase, strip non-alphanumerics, drop short tokens, sort, dedup, join) and hashes it with 32-bit FNV-1a.
 * Reordered words collide intentionally; deterministic across processes and V8 versions. */
export function hashQueryText(query: string): number {
  if (!query) return 0;
  // Tokens are deduped before join so `foo foo bar` and `foo bar` count as one query for memory_dominance.
  // Unicode classes (\p{L}, \p{N}, \p{M}; need /u) keep non-Latin queries from collapsing to an empty token set and colliding at hash 0.
  const normalized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  // Drop tokens under 3 chars (filler words) so `a login bug` and `login bug` hash
  // alike; matches the >=3 filter in src/learn/forward-claim-detector.ts.
  const filtered = normalized.filter((t) => t.length >= 3);
  // Fall back to all tokens when the filter empties the query (CJK 2-char words,
  // acronyms like `AI`) so distinct short queries do not all hash to fnv1a32('').
  const tokens = filtered.length > 0 ? filtered : normalized;
  const deduped = Array.from(new Set(tokens)).sort();
  return fnv1a32(deduped.join(' '));
}

function fnv1a32(text: string): number {
  // FNV-1a 32-bit. Offset basis 2166136261, prime 16777619.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 32-bit multiply via Math.imul — handles overflow correctly.
    hash = Math.imul(hash, 16777619);
  }
  // Coerce to unsigned 32-bit for stable comparison.
  return hash >>> 0;
}

/** Detects anchoring against the current (queryHash, topMemoryId); memory_dominance wins when both rules fire, since it spans DIFFERENT queries.
 * Cooldown is per memory: a hint on the SAME topMemoryId within `cooldown=3` history entries is suppressed. Returns an AnchoringHint or null. */
export function detectAnchoring(
  history: RecallHistorySnapshot,
  currentQueryHash: number,
  currentTopMemoryId: string | null,
  opts: DetectAnchoringOpts = {},
): AnchoringHint | null {
  if (currentTopMemoryId === null) return null;
  const minDominance = opts.minDominance ?? DEFAULT_MIN_DOMINANCE;
  const recentRepeatWindow = opts.recentRepeatWindow ?? DEFAULT_RECENT_REPEAT_WINDOW;
  const cooldown = opts.cooldown ?? DEFAULT_COOLDOWN;

  // Cooldown gate: was the most-recent hint (across the last `cooldown`
  // entries) for THIS memory? If yes, suppress regardless of rule.
  const cooldownSlice = history.slice(-cooldown);
  for (const entry of cooldownSlice) {
    if (entry.anchoredOn === currentTopMemoryId) {
      return null;
    }
  }

  // memory_dominance check FIRST (wins on tie).
  const queryCount = countDistinctQueries(history, currentQueryHash, currentTopMemoryId);
  if (queryCount >= minDominance) {
    return {
      reason: 'memory_dominance',
      memoryId: currentTopMemoryId,
      queryCount,
      summary: `Memory ${currentTopMemoryId} has been the top result for ${queryCount} distinct queries in this session and may be anchoring your reasoning.`,
      source: 'j1-recurrence',
    };
  }

  if (isRecentRepeat(history, recentRepeatWindow, currentQueryHash, currentTopMemoryId)) {
    return {
      reason: 'query_repeat',
      memoryId: currentTopMemoryId,
      summary: `Same query phrasing as a recent recall returned the same top result (${currentTopMemoryId}); you may be re-asking the same question.`,
      source: 'j1-recurrence',
    };
  }

  return null;
}

// Count distinct queryHashes in history where topMemoryId === the current top
// (excluding null tops), plus the current query itself.
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

// query_repeat check: is currentQueryHash present in the last `recentRepeatWindow`
// entries AND was that entry's topMemoryId === currentTopMemoryId?
function isRecentRepeat(
  history: RecallHistorySnapshot,
  recentRepeatWindow: number,
  currentQueryHash: number,
  currentTopMemoryId: string,
): boolean {
  return history
    .slice(-recentRepeatWindow)
    .some((entry) => entry.queryHash === currentQueryHash && entry.topMemoryId === currentTopMemoryId);
}

const MAX_HISTORY = 10;
const DEFAULT_MAX_SESSIONS = 1000;

/** Bounded FIFO ring of RecallHistoryEntry (oldest evicted when full); a thin array wrapper so snapshotRing returns a readonly view without copying. */
export class RingBuffer {
  private entries: RecallHistoryEntry[] = [];

  append(entry: RecallHistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_HISTORY) {
      this.entries.shift();
    }
  }

  snapshot(): RecallHistorySnapshot {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }
}

/** Builds the (tenant, session) key with a NUL delimiter: tenant and session ids are validated elsewhere to reject NUL,
 * so concatenation cannot collide even though API-key-derived subjects can contain `:`. */
export function buildSessionKey(tenantId: string, sessionId: string): string {
  return `${tenantId}\x00${sessionId}`;
}

/** Get-or-create a RingBuffer per session key, capped at `maxSessions` (default 1000); at the cap the oldest-inserted key (first from Map.keys()) is
 * evicted. */
export function getOrCreateRing(
  map: Map<string, RingBuffer>,
  key: string,
  maxSessions: number = DEFAULT_MAX_SESSIONS,
): RingBuffer {
  const existing = map.get(key);
  if (existing) {
    // LRU touch: delete + re-insert to move to back of iteration order.
    map.delete(key);
    map.set(key, existing);
    return existing;
  }
  if (map.size >= maxSessions) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  const ring = new RingBuffer();
  map.set(key, ring);
  return ring;
}

/** Appends a recall to a ring; `anchoredOn` is the memoryId of the hint that fired on THIS recall (or undefined), read by detectAnchoring for cooldown. */
export function appendRecall(
  ring: RingBuffer,
  queryHash: number,
  topMemoryId: string | null,
  anchoredOn?: string,
): void {
  const entry: RecallHistoryEntry = {
    queryHash,
    topMemoryId,
    ts: new Date().toISOString(),
  };
  if (anchoredOn !== undefined) entry.anchoredOn = anchoredOn;
  ring.append(entry);
}

/** Snapshot a ring as a readonly RecallHistorySnapshot. */
export function snapshotRing(ring: RingBuffer): RecallHistorySnapshot {
  return ring.snapshot();
}

/** Whether a recall bias hint is enabled; reads env at call time, so `HIPPO_ANCHORING=off` or `HIPPO_AVAILABILITY=off` disables only that kind. */
export function biasHintEnabled(kind: 'anchoring' | 'availability'): boolean {
  return kind === 'anchoring'
    ? !envAnchoringOff()
    : !envAvailabilityOff();
}
