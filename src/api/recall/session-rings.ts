// Per-caller rings of recent recalls: the history the anchoring hint reads.
import type { CallerState } from '../callers.js';
import {
  type RecallHistoryEntry,
  type RecallHistorySnapshot,
  hashQueryText,
  type HintConfig,
  biasHintEnabled,
} from './anchoring.js';

const MAX_HISTORY = 10;
const DEFAULT_MAX_SESSIONS = 1000;

/**
 * Bounded FIFO ring of RecallHistoryEntry (oldest evicted when full); a thin array wrapper so
 * snapshotRing returns a readonly view without copying.
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

/** Builds the (tenant, session) key with a NUL delimiter: tenant and session ids are validated
 * elsewhere to reject NUL, so concatenation cannot collide even though API-key-derived subjects
 * can contain `:`. */
export function buildSessionKey(tenantId: string, sessionId: string): string {
  return `${tenantId}\x00${sessionId}`;
}

/**
 * Get-or-create a RingBuffer per session key, capped at `maxSessions` (default 1000); at the cap
 * the oldest-inserted key (first from Map.keys()) is evicted. */
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

export interface AppendRecallOptions {
  readonly ring: RingBuffer;
  readonly queryHash: number;
  readonly topMemoryId: string | null;
  readonly now: Date;
  readonly anchoredOn?: string;
}

/**
 * Appends a recall to a ring; `anchoredOn` is the memoryId of the hint that fired on THIS recall
 * (or undefined), read by detectAnchoring for cooldown.
 */
export function appendRecall({
  ring,
  queryHash,
  topMemoryId,
  now,
  anchoredOn,
}: AppendRecallOptions): void {
  const entry: RecallHistoryEntry = {
    queryHash,
    topMemoryId,
    ts: now.toISOString(),
  };
  if (anchoredOn !== undefined) entry.anchoredOn = anchoredOn;
  ring.append(entry);
}

/** Snapshot a ring as a readonly RecallHistorySnapshot. */
export function snapshotRing(ring: RingBuffer): RecallHistorySnapshot {
  return ring.snapshot();
}

export type RecallSurface = 'cli' | 'mcp' | 'http';

/** Whose rings a recall reads: the root's callers, under the recall's tenant. */
export interface RingOwner {
  readonly config: HintConfig;
  readonly tenantId: string;
  readonly callers?: CallerState;
}

/** The session's ring, created on first use; null when anchoring is off, the call has no
 * session, or the root keeps no callers. */
export function sessionRing(
  owner: RingOwner,
  surface: RecallSurface,
  sessionId: string | undefined,
): RingBuffer | null {
  const rings = owner.callers?.rings[surface];
  if (rings === undefined || !biasHintEnabled(owner.config, 'anchoring') || !sessionId) return null;
  return getOrCreateRing(rings, buildSessionKey(owner.tenantId, sessionId));
}

/**
 * The session's history, read without creating or touching its ring, so a request that then fails
 * evicts no live session.
 */
export function peekSessionRing(
  owner: RingOwner,
  surface: RecallSurface,
  sessionId: string,
): RecallHistorySnapshot {
  const ring = owner.callers?.rings[surface].get(buildSessionKey(owner.tenantId, sessionId));
  return ring ? snapshotRing(ring) : [];
}

export interface NoteRecallOptions {
  readonly ring: RingBuffer;
  readonly query: string;
  readonly topId: string | null;
  readonly anchoredOn: string | undefined;
  readonly now: Date;
}

/** Records this recall's top row and hint, which the next recall's cooldown reads. */
export function noteRecall({ ring, query, topId, anchoredOn, now }: NoteRecallOptions): void {
  appendRecall({ ring, queryHash: hashQueryText(query), topMemoryId: topId, now, anchoredOn });
}
