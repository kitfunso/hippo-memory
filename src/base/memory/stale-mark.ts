import type { MemoryEntry } from './entry.js';

/** The tag invalidation puts on a memory it weakened. */
export const INVALIDATED_TAG = 'invalidated';

/** The tag a decision puts on the memory it replaced. */
export const SUPERSEDED_TAG = 'superseded';

/** The row marked stale under tag `marker`, its half-life halved only when it is not already stale under that
 * marker: repeating the act changes nothing, and a marker copied onto a fresh row does not block the first halving. */
export function markStale(entry: MemoryEntry, marker: string): MemoryEntry {
  const tagged = entry.tags.includes(marker);
  if (tagged && entry.confidence === 'stale') return { ...entry };
  return {
    ...entry,
    confidence: 'stale',
    halfLifeDays: Math.max(1, Math.floor(entry.halfLifeDays / 2)),
    tags: tagged ? entry.tags : [...entry.tags, marker],
  };
}
