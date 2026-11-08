import type { MemoryEntry } from './entry.js';

/** The tag invalidation puts on a memory it weakened. */
export const INVALIDATED_TAG = 'invalidated';

/** The tag a decision puts on the memory it replaced. */
export const SUPERSEDED_TAG = 'superseded';

/** The row after an act that withdraws trust in it, marked by tag `marker`: stored tier stale, and
 * half-life halved only the first time that marker lands, so repeating the act changes nothing more. */
export function markStale(entry: MemoryEntry, marker: string): MemoryEntry {
  if (entry.tags.includes(marker)) return { ...entry, confidence: 'stale' };
  return {
    ...entry,
    confidence: 'stale',
    halfLifeDays: Math.max(1, Math.floor(entry.halfLifeDays / 2)),
    tags: [...entry.tags, marker],
  };
}
