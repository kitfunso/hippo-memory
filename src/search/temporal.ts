import type { MemoryEntry } from '../memory.js';

const TEMPORAL_RECENT_CUES = new Set(['recently', 'latest', 'last', 'newest', 'current', 'today']);
const TEMPORAL_OLDEST_CUES = new Set(['first', 'earliest', 'oldest', 'initially', 'originally']);

export type TemporalDirection = 'recent' | 'oldest' | null;

export function detectTemporalDirection(query: string): TemporalDirection {
  const words = query.toLowerCase().split(/\s+/);
  for (const w of words) {
    if (TEMPORAL_RECENT_CUES.has(w)) return 'recent';
    if (TEMPORAL_OLDEST_CUES.has(w)) return 'oldest';
  }
  return null;
}

export interface TemporalRange {
  minTime: number;
  maxTime: number;
}

export function computeTemporalRange(entries: MemoryEntry[]): TemporalRange {
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const e of entries) {
    const t = new Date(e.created).getTime();
    if (t < minTime) minTime = t;
    if (t > maxTime) maxTime = t;
  }
  return { minTime, maxTime };
}

// A temporal cue scales rank linearly across the pool time range, from the floor to floor + span.
const TEMPORAL_BOOST_FLOOR = 0.8;
const TEMPORAL_BOOST_SPAN = 0.4;

export function temporalBoost(entry: MemoryEntry, direction: TemporalDirection, range: TemporalRange): number {
  if (!direction) return 1.0;

  const span = range.maxTime - range.minTime;
  if (span === 0) return 1.0;

  const entryTime = new Date(entry.created).getTime();
  const normalized = (entryTime - range.minTime) / span;

  if (direction === 'recent') {
    return TEMPORAL_BOOST_FLOOR + TEMPORAL_BOOST_SPAN * normalized;
  } else {
    return TEMPORAL_BOOST_FLOOR + TEMPORAL_BOOST_SPAN * (1 - normalized);
  }
}

/** The query's temporal cue and, only when there is one, the pool's time range. */
export function temporalContext(query: string, entries: MemoryEntry[]) {
  const direction = detectTemporalDirection(query);
  return { direction, range: direction ? computeTemporalRange(entries) : { minTime: 0, maxTime: 0 } };
}
