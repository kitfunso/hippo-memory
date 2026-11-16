import type { MemoryEntry } from './entry.js';

/** The tag invalidation puts on a memory it weakened. */
export const INVALIDATED_TAG = 'invalidated';

/** The tag a decision puts on the memory it replaced. */
export const SUPERSEDED_TAG = 'superseded';

/** The tag a resolved conflict puts on the memory it weakened. */
export const CONFLICT_LOSER_TAG = 'conflict-loser';

const halve = (halfLifeDays: number): number => Math.max(1, Math.floor(halfLifeDays / 2));

/** The row marked stale under tag `marker`, its half-life cut (halved by default) only when it is not already stale
 * under that marker: repeating the act changes nothing, and a marker copied onto a fresh row does not block the
 * first cut. */
export function markStale(
  entry: MemoryEntry,
  marker: string,
  cut: (halfLifeDays: number) => number = halve,
): MemoryEntry {
  const tagged = entry.tags.includes(marker);
  if (tagged && entry.confidence === 'stale') return { ...entry };
  return {
    ...entry,
    confidence: 'stale',
    halfLifeDays: cut(entry.halfLifeDays),
    tags: tagged ? entry.tags : [...entry.tags, marker],
  };
}
