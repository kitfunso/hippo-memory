// A memory as hippo.db reads it back after a write: its column defaults filled and its stamp normalized, so both
// adapters return the same entry for the same write.
import { isoInstant } from '../../base/memory/created-stamp.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { storedEntry } from '../rules/stored-entry.js';

// A JSON list column holds each item as text once it is read.
const textList = (items: readonly unknown[] | undefined): string[] => (items ?? []).map(String);

/** `entry` as a write over `prior` stores it; only toISOString stamps sort by time, so `created` is rewritten so. The
 * rebuild-queue fields are the sleep rebuild's, so a row write keeps the stored row's. */
export function asStored(entry: MemoryEntry, prior: MemoryEntry | undefined): MemoryEntry {
  return storedEntry({
    ...entry,
    created: isoInstant(entry.created) ?? entry.created,
    tags: textList(entry.tags),
    conflictsWith: textList(entry.conflictsWith),
    parents: textList(entry.parents),
    summaryDirty: prior?.summaryDirty,
    lastRebuiltAt: prior?.lastRebuiltAt,
    rebuildCount: prior?.rebuildCount,
  });
}
