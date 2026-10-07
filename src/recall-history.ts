/**
 * Anchoring detector (recall-recurrence), pure module.
 *
 * Implements two detection rules:
 *   query_repeat: same queryHash within recentRepeatWindow returned
 *     same topMemoryId (caller is re-asking the same question).
 *   memory_dominance: same topMemoryId across >= minDominance distinct
 *     queryHashes (memory acts as a fixed-point anchor regardless of what
 *     the agent asks).
 *
 * Each pipeline (api.recall via
 * HTTP, cmdRecall, MCP hippo_recall) owns its OWN ring buffer Map keyed
 * by (tenant, session). No cross-pipeline sharing (the typical multi-
 * process deployment makes IPC ring-sharing impractical; per-pipeline
 * is correct because each pipeline has its own top-1 ranking anyway).
 *
 * AnchoringHint + PlanningFallacyHint are independent
 * signals; both can fire on the same recall.
 */

import { envAnchoringOff, envAvailabilityOff } from './env.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

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
  /** Memory id of the AnchoringHint that fired on this recall, if any.
   *  Used by the cooldown logic to prevent re-emitting the same hint on
   *  consecutive recalls within the dominance window. Caller-written
   *  AFTER detectAnchoring returns; reads next time detectAnchoring runs. */
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
  /** Cooldown: if the immediately-prior fire (per `anchoredOn`) was for
   *  the same topMemoryId within this many history entries, suppress.
   *  Default 3. */
  cooldown?: number;
}

const DEFAULT_MIN_DOMINANCE = 3;
const DEFAULT_RECENT_REPEAT_WINDOW = 5;
const DEFAULT_COOLDOWN = 3;

// ---------------------------------------------------------------------------
// Query text normalization + hashing
// ---------------------------------------------------------------------------

/**
 * Normalize + hash a query text into a 32-bit integer.
 * Lowercase → strip non-alphanumeric → split → drop empty + short tokens →
 * sort tokens → join → FNV-1a 32-bit.
 *
 * Token sort + dedup means semantically-equivalent queries with reordered
 * words collide intentionally ("semantically-distinct" is approximated by
 * textual normalization, not embeddings).
 *
 * Deterministic across processes; stable across Node + V8 versions.
 */
export function hashQueryText(query: string): number {
  if (!query) return 0;
  // Tokens are deduped before join so `foo foo bar` and `foo bar` count as one query for memory_dominance.
  // Unicode classes (\p{L} letter, \p{N} number, \p{M} combining mark; needs /u) keep
  // non-Latin queries from collapsing to an empty token set and colliding at hash 0.
  const normalized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  // Drop tokens under 3 chars (filler words) so `a login bug` and `login bug` hash
  // alike; matches the >=3 filter in src/forward-claim-detector.ts.
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

// ---------------------------------------------------------------------------
// Anchoring detection
// ---------------------------------------------------------------------------

/**
 * Detect anchoring patterns in the recall history against the current
 * recall's (queryHash, topMemoryId).
 *
 * Rule precedence: memory_dominance wins on tie. When both rules fire on the
 * same recall, return only memory_dominance, the stronger signal (a memory
 * dominating multiple DIFFERENT queries is a fixed-point anchor; query_repeat
 * alone is just a literal re-ask).
 *
 * Cooldown: if the immediately-prior recall fired a hint on the SAME
 * topMemoryId within `cooldown=3` history entries, suppress. Prevents
 * spam when the agent repeatedly recalls within the dominance window.
 * Cooldown is per-memory, not per-rule: if memory_dominance fired on M
 * (cooldown engaged for M), and the next recall has top=N + repeated query,
 * query_repeat fires on N (different memory, not in cooldown).
 *
 * @returns AnchoringHint when a pattern fires; null otherwise.
 */
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

  // memory_dominance check FIRST (wins on tie). Count distinct queryHashes in history
  // where topMemoryId === currentTopMemoryId (excluding null tops).
  const matchingQueryHashes = new Set<number>();
  for (const entry of history) {
    if (entry.topMemoryId === currentTopMemoryId) {
      matchingQueryHashes.add(entry.queryHash);
    }
  }
  // Include current query in the count.
  matchingQueryHashes.add(currentQueryHash);
  const queryCount = matchingQueryHashes.size;
  if (queryCount >= minDominance) {
    return {
      reason: 'memory_dominance',
      memoryId: currentTopMemoryId,
      queryCount,
      summary: `Memory ${currentTopMemoryId} has been the top result for ${queryCount} distinct queries in this session and may be anchoring your reasoning.`,
      source: 'j1-recurrence',
    };
  }

  // query_repeat check: is currentQueryHash present in the last `recentRepeatWindow`
  // entries AND was that entry's topMemoryId === currentTopMemoryId?
  const r1Slice = history.slice(-recentRepeatWindow);
  for (const entry of r1Slice) {
    if (entry.queryHash === currentQueryHash && entry.topMemoryId === currentTopMemoryId) {
      return {
        reason: 'query_repeat',
        memoryId: currentTopMemoryId,
        summary: `Same query phrasing as a recent recall returned the same top result (${currentTopMemoryId}); you may be re-asking the same question.`,
        source: 'j1-recurrence',
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// RingBuffer + caller-side state helpers
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10;
const DEFAULT_MAX_SESSIONS = 1000;

/**
 * Bounded FIFO ring of RecallHistoryEntry. Newest entries pushed via
 * append; oldest evicted when the ring is full. The class is intentionally
 * a thin wrapper around an array so snapshotRing returns a readonly view
 * without copying on the hot path.
 */
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

/**
 * Build the (tenant, session) key for a per-session ring Map. Uses a NUL
 * (`\x00`) byte as delimiter because tenant ids and session ids are
 * validated elsewhere to reject NUL chars — guarantees collision-free
 * concatenation regardless of what `:` or other delimiters might appear
 * inside either field (notably API-key-derived subjects can contain `:`).
 */
export function buildSessionKey(tenantId: string, sessionId: string): string {
  return `${tenantId}\x00${sessionId}`;
}

/**
 * Get-or-create a RingBuffer for a session key. Caps total tracked keys
 * at `maxSessions` (default 1000) with LRU eviction — when the cap is
 * hit, deletes the oldest-inserted key before inserting the new one.
 * Map iteration order preserves insertion order per ECMA-262 spec, so
 * "oldest" = first key returned by Map.prototype.keys().
 */
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

/**
 * Append a recall to a ring. The `anchoredOn` argument carries the
 * memoryId of the AnchoringHint that fired on THIS recall (or undefined
 * if no hint). detectAnchoring reads it next time for cooldown gating.
 */
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

/**
 * Whether a recall bias hint is enabled. Reads the env at call time, so
 * `HIPPO_ANCHORING=off` or `HIPPO_AVAILABILITY=off` disables only that kind.
 */
export function biasHintEnabled(kind: 'anchoring' | 'availability'): boolean {
  return kind === 'anchoring'
    ? !envAnchoringOff()
    : !envAvailabilityOff();
}
