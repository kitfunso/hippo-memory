/**
 * Store-level deduplication. Scans for near-duplicate memories by content
 * Jaccard overlap, keeps the stronger copy (by strength + retrieval count),
 * removes the rest.
 *
 * Extracted from cli.ts in Episode A (v1.11.3) so `api.sleep` can dedupe
 * during the consolidation pipeline without violating the cli -> api
 * dependency direction. `cmdDedup` in cli.ts continues to import and use
 * this function unchanged.
 */

import { textOverlap } from './search.js';
import { loadAllEntries, deleteEntry } from './store.js';

export interface DedupPair {
  kept: string;
  keptContent: string;
  keptLayer: string;
  keptStrength: number;
  removed: string;
  removedContent: string;
  removedLayer: string;
  removedStrength: number;
  similarity: number;
}

/**
 * Scan the store for near-duplicate memories and remove the weaker copy.
 * Two memories are duplicates if their content has > threshold Jaccard overlap.
 * Keeps the one with higher strength (or more retrievals if tied).
 */
export function deduplicateStore(
  hippoRoot: string,
  options: { threshold?: number; dryRun?: boolean } = {}
): { removed: number; pairs: DedupPair[] } {
  const threshold = options.threshold ?? 0.7;
  const dryRun = options.dryRun ?? false;
  const entries = loadAllEntries(hippoRoot);

  // Sort by strength desc, then retrieval count, so we keep the most valuable copy
  entries.sort((a, b) => {
    const sDiff = (b.strength ?? 0) - (a.strength ?? 0);
    if (Math.abs(sDiff) > 0.01) return sDiff;
    return (b.retrieval_count ?? 0) - (a.retrieval_count ?? 0);
  });

  const removed = new Set<string>();
  const pairs: DedupPair[] = [];

  for (let i = 0; i < entries.length; i++) {
    if (removed.has(entries[i].id)) continue;
    for (let j = i + 1; j < entries.length; j++) {
      if (removed.has(entries[j].id)) continue;

      const similarity = textOverlap(entries[i].content, entries[j].content);
      if (similarity <= threshold) continue;

      removed.add(entries[j].id);
      pairs.push({
        kept: entries[i].id,
        keptContent: entries[i].content,
        keptLayer: entries[i].layer,
        keptStrength: entries[i].strength ?? 0,
        removed: entries[j].id,
        removedContent: entries[j].content,
        removedLayer: entries[j].layer,
        removedStrength: entries[j].strength ?? 0,
        similarity,
      });
    }
  }

  if (!dryRun) {
    for (const id of removed) {
      deleteEntry(hippoRoot, id);
    }
  }

  return { removed: removed.size, pairs };
}
