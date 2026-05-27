/**
 * J1 anchoring detector (recall-recurrence) — pure module.
 *
 * Implements two detection rules from ROADMAP-RESEARCH.md L546:
 *   R1 query_repeat: same queryHash within recentRepeatWindow returned
 *     same topMemoryId (caller is re-asking the same question).
 *   R2 memory_dominance: same topMemoryId across >= minDominance distinct
 *     queryHashes (memory acts as a fixed-point anchor regardless of what
 *     the agent asks).
 *
 * Per the plan v3 architectural decision: each pipeline (api.recall via
 * HTTP, cmdRecall, MCP hippo_recall) owns its OWN ring buffer Map keyed
 * by (tenant, session). No cross-pipeline sharing (the typical multi-
 * process deployment makes IPC ring-sharing impractical; per-pipeline
 * is correct because each pipeline has its own top-1 ranking anyway).
 *
 * Plan: docs/plans/2026-05-26-j1-anchoring-detector.md.
 * Composes with J3.2: AnchoringHint + PlanningFallacyHint are independent
 * signals; both can fire on the same recall.
 */

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
  /** ISO-8601 timestamp; advisory, not used by R1/R2 logic. */
  ts: string;
  /** Memory id of the AnchoringHint that fired on this recall, if any.
   *  Used by R1/R2 cooldown logic to prevent re-emitting the same hint on
   *  consecutive recalls within the dominance window. Caller-written
   *  AFTER detectAnchoring returns; reads next time detectAnchoring runs. */
  anchoredOn?: string;
}

export type RecallHistorySnapshot = readonly RecallHistoryEntry[];

export interface DetectAnchoringOpts {
  /** R2 threshold: number of distinct queryHashes that must have returned
   *  the same topMemoryId. Default 3. */
  minDominance?: number;
  /** R1 window: how many recent history entries to scan for query repeat.
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
 * words collide intentionally (the roadmap's "semantically-distinct" v1
 * uses textual normalization; embedding-based distinctness is J1-v2).
 *
 * Deterministic across processes; stable across Node + V8 versions.
 */
export function hashQueryText(query: string): number {
  if (!query) return 0;
  // Token dedup before join: the R2 contract says "distinct queries"
  // means semantically distinct, so `foo bar` and `foo foo bar` should
  // collapse to the same hash. Without dedup, simple phrasing
  // variations (typos, doubled tokens, intensifiers) would inflate
  // distinct-query counts and trip R2 on essentially the same question.
  // Codex round-1 catch.
  // Unicode-aware tokenization (codex round-3 P2 catch): the prior
  // ASCII-only [^a-z0-9\s] pattern stripped every non-Latin letter, so
  // Japanese, Arabic, Cyrillic, accented-Latin etc. queries collapsed
  // to empty token set -> hash 0 -> false R1 collisions across distinct
  // non-English queries. \p{L} = any Unicode letter, \p{N} = any Unicode
  // number, \p{M} = combining marks (preserve composed accented chars).
  // Requires the /u flag and Node >= 12.
  const normalized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  // Drop tokens shorter than 3 chars to match the normalizer contract
  // (filler / stop words). Without this, `a login bug` vs `login bug`
  // hash differently and inflate R2 distinct-query counts, firing
  // memory_dominance on repeated phrasings of the same question.
  // Codex round-4 P2 catch. Matches the same >=3 filter in
  // src/forward-claim-detector.ts for class-resolver tokens.
  const filtered = normalized.filter((t) => t.length >= 3);
  // Fallback when the >=3 filter would collapse the entire query to
  // empty: CJK queries like `测试` / `环境` are 2-char tokens; English
  // acronyms like `AI` / `UI` are 2 chars. Without this fallback they
  // all hash to fnv1a32(''), producing false R1 collisions across
  // distinct short-token queries. Codex round-5 P2 catch.
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
 * Rule precedence: R2 (memory_dominance) wins on tie. When both R1 and R2
 * fire on the same recall, return only the R2 hint — R2's signal is the
 * cognitively stronger one (a memory dominating multiple DIFFERENT queries
 * is a fixed-point anchor; R1 alone is just a literal re-ask).
 *
 * Cooldown: if the immediately-prior recall fired a hint on the SAME
 * topMemoryId within `cooldown=3` history entries, suppress. Prevents
 * spam when the agent repeatedly recalls within the dominance window.
 * Cooldown is per-memory, not per-rule: if R2 fired on M (cooldown
 * engaged for M), and the next recall has top=N + repeated query →
 * R1 fires on N (different memory, not in cooldown).
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

  // R2 check FIRST (wins on tie). Count distinct queryHashes in history
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

  // R1 check: is currentQueryHash present in the last `recentRepeatWindow`
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
