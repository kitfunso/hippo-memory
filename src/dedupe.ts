/**
 * Store-level deduplication. Scans for near-duplicate memories by content
 * Jaccard overlap, keeps the stronger copy (by strength + retrieval count),
 * removes the rest.
 *
 * Extracted from cli.ts in Episode A (v1.11.3) so `api.sleep` can dedupe
 * during the consolidation pipeline without violating the cli -> api
 * dependency direction. `cmdDedup` in cli.ts continues to import and use
 * this function unchanged.
 *
 * Survivor selection is a total order as of v1.26.3
 * (docs/plans/2026-07-16-dedupe-survivor-determinism.md): strength bucket
 * desc -> retrieval_count desc -> compareEntryIdentity (content asc -> id
 * asc). Previously the strength/retrieval-count comparator could tie
 * exactly with no terminal key, so the survivor fell to load order
 * (arrival-order-dependent); see `strengthBucket` below for the bucket
 * encoding.
 */

import { textOverlap } from './search.js';
import { loadAllEntries, deleteEntry } from './store.js';
import { compareEntryIdentity } from './compare.js';

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

/** Quantization step for strength-tie comparisons. The historical 0.01
 *  epsilon (see `strengthBucket` below) applied via rounding instead of a
 *  raw abs-diff threshold, so the tiebreak is transitive. */
const STRENGTH_TIE_EPSILON = 0.01;

/**
 * Quantize a strength value into an integer "bucket" for tie comparison.
 *
 * Encodes the historical 0.01 epsilon transitively: two strengths compare
 * equal here iff they round to the same multiple of `STRENGTH_TIE_EPSILON`,
 * which (unlike a raw `Math.abs(a - b) > epsilon` check) is a genuine
 * equivalence relation — no more "A ties B, B ties C, but A beats C"
 * (see the file-level history note above).
 *
 * Non-finite input (`NaN`, `+/-Infinity`) maps to bucket `0` rather than
 * propagating: a NaN bucket would make the sort comparator return NaN,
 * silently reintroducing the non-total-order class this fix exists to kill.
 * (`null`/`undefined` already default to strength `0` via `?? 0`, same as
 * before this change.)
 *
 * Bucket-edge nuance: two strengths straddling a bucket edge (e.g. 0.0049 vs
 * 0.0051) now compare as different, where the old raw-epsilon check called
 * them tied. The flip always favors the not-weaker entry, and the OLD
 * behavior at such pairs was itself order/engine-dependent (the defect this
 * fix exists to kill) — so there is no stable prior behavior being broken.
 */
export function strengthBucket(strength: number | null | undefined): number {
  const s = strength ?? 0;
  return Number.isFinite(s) ? Math.round(s / STRENGTH_TIE_EPSILON) : 0;
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

  // Total order so the survivor is a deterministic function of the entry
  // multiset, not of load/ingest order: strength bucket desc
  // (materially-stronger survives) -> retrieval_count desc (more-retrieved
  // survives on a strength tie) -> compareEntryIdentity (content asc -> id
  // asc), the cross-ingest-stable terminal key. Without a terminal key,
  // freshly-ingested near-duplicates tie exactly (strength=1,
  // retrieval_count=0) and the stable sort falls through to
  // loadAllEntries's `created ASC, id ASC` order -- arrival order.
  // finiteCount mirrors strengthBucket's non-finite hardening on the
  // retrieval leg: a NaN retrieval_count would make the comparator return
  // NaN and break the total order the same way a NaN bucket would.
  // Unreachable via the schema (non-nullable INTEGER column), so this is
  // symmetry, not a live bug.
  const finiteCount = (n: number | null | undefined): number =>
    Number.isFinite(n ?? 0) ? (n ?? 0) : 0;
  entries.sort((a, b) => {
    const bucketDiff = strengthBucket(b.strength) - strengthBucket(a.strength);
    if (bucketDiff !== 0) return bucketDiff;
    const retrievalDiff = finiteCount(b.retrieval_count) - finiteCount(a.retrieval_count);
    if (retrievalDiff !== 0) return retrievalDiff;
    return compareEntryIdentity(a, b);
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
