/** Store-level dedup: same text apart from spacing, keeping the stronger copy; split out so `api.sleep` can dedupe without cli -> api imports.
 * Survivor order is total and tenant-scoped: strength bucket, retrieval_count, then compareEntryIdentity; raw and superseded rows are not candidates. */

import { textOverlap } from '../util/tokenize.js';
import { loadCurrentDistilledEntries } from '../store/entry-reads.js';
import { deleteEntriesOneByOne, memoriesBackingObjects } from '../store/delete-and-batch.js';
import { compareEntryIdentity } from '../core/compare.js';
import { canAutoDelete, type MemoryEntry } from '../core/memory.js';
import { derivationPartitionKey } from '../store/recall-scope.js';
import { duplicateKey } from '../util/same-text.js';

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

/** Result of `deduplicateStore`: how many entries were removed, and the kept/removed pairs. */
export interface DedupResult {
  removed: number;
  pairs: DedupPair[];
}

/** Quantization step for strength-tie comparisons: the 0.01 epsilon applied by rounding instead of an abs-diff threshold, so the tiebreak is transitive. */
const STRENGTH_TIE_EPSILON = 0.01;

/** Quantize strength to an integer bucket so ties are a true equivalence relation (equal iff same multiple of `STRENGTH_TIE_EPSILON`).
 * Non-finite input maps to 0: a NaN bucket would make the comparator return NaN and break the total order. */
export function strengthBucket(strength: number | null | undefined): number {
  const s = strength ?? 0;
  return Number.isFinite(s) ? Math.round(s / STRENGTH_TIE_EPSILON) : 0;
}

// finiteCount hardens the retrieval leg like strengthBucket: a NaN would break the total order.
// Unreachable via the schema (non-nullable INTEGER column); kept for symmetry.
const finiteCount = (n: number | null | undefined): number =>
  Number.isFinite(n ?? 0) ? (n ?? 0) : 0;

/** The v1.26.3 survivor total order: strength bucket desc, then retrieval_count desc, then compareEntryIdentity. */
function survivorOrder(a: MemoryEntry, b: MemoryEntry): number {
  const bucketDiff = strengthBucket(b.strength) - strengthBucket(a.strength);
  if (bucketDiff !== 0) return bucketDiff;
  const retrievalDiff = finiteCount(b.retrieval_count) - finiteCount(a.retrieval_count);
  if (retrievalDiff !== 0) return retrievalDiff;
  return compareEntryIdentity(a, b);
}

// Tenant partition: group by tenantId before sorting so a duplicate pair never forms across tenants; Map keeps insertion order,
// so a single-tenant store gets one group and the same result as a global pass.
function entriesByPartition(entries: readonly MemoryEntry[]): Map<string, MemoryEntry[]> {
  const entriesByTenant = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    // EI2: also split by restricted scope, else a private copy can delete the readable one.
    const key = derivationPartitionKey(entry.tenantId, entry.scope, entry.origin_project);
    const bucket = entriesByTenant.get(key);
    if (bucket) bucket.push(entry);
    else entriesByTenant.set(key, [entry]);
  }
  return entriesByTenant;
}

function dedupPair(kept: MemoryEntry, dropped: MemoryEntry): DedupPair {
  return {
    kept: kept.id,
    keptContent: kept.content,
    keptLayer: kept.layer,
    keptStrength: kept.strength ?? 0,
    removed: dropped.id,
    removedContent: dropped.content,
    removedLayer: dropped.layer,
    removedStrength: dropped.strength ?? 0,
    similarity: textOverlap(kept.content, dropped.content),
  };
}

/** Pairs within one partition, already in survivor order, grouped by survivor; marks each loser in `removed`. */
function partitionPairs(tenantEntries: readonly MemoryEntry[], removed: Set<string>, backing: ReadonlySet<string>): DedupPair[] {
  const groups = new Map<string, { survivor: MemoryEntry; pairs: DedupPair[] }>();
  for (const entry of tenantEntries) {
    const key = duplicateKey(entry.content);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { survivor: entry, pairs: [] });
      continue;
    }
    if (!canAutoDelete(entry) || backing.has(entry.id)) continue;
    removed.add(entry.id);
    group.pairs.push(dedupPair(group.survivor, entry));
  }
  return [...groups.values()].flatMap((group) => group.pairs);
}

/** Every row of the store, read once by a caller that also needs them, with the ids of rows backing an object. */
export interface LoadedStore {
  readonly entries: readonly MemoryEntry[];
  readonly backing: ReadonlySet<string>;
}

/** The rows loadCurrentDistilledEntries selects, picked from a whole-store read. */
const isCurrentDistilled = (e: MemoryEntry): boolean => (e.kind ?? 'distilled') === 'distilled' && !e.superseded_by;

/** Remove the weaker copy of same-text (apart from spacing) memories within one tenant; cross-tenant pairs are never duplicates (isolation boundary).
 * Higher strength wins, then more retrievals; `threshold` is accepted for old callers and ignored. */
export function deduplicateStore(
  hippoRoot: string,
  options: { threshold?: number; dryRun?: boolean; actor?: string; loaded?: LoadedStore } = {}
): DedupResult {
  const dryRun = options.dryRun ?? false;
  // Only current distilled rows compete: raw rows are append-only (the delete
  // trigger would abort sleep mid-loop) and superseded rows are history.
  const entries = options.loaded?.entries.filter(isCurrentDistilled) ?? loadCurrentDistilledEntries(hippoRoot);
  const entriesByTenant = entriesByPartition(entries);

  // Shared across tenant groups: ids are globally unique UUIDs, so `removed` cannot collide across tenants and deleteEntry deletes by primary key alone.
  const removed = new Set<string>();
  const pairs: DedupPair[] = [];
  const backing = options.loaded?.backing ?? memoriesBackingObjects(hippoRoot);

  for (const tenantEntries of entriesByTenant.values()) {
    // The survivor total order (see the file-level docstring), scoped per
    // tenant group: the total order holds within a tenant only, matching the partition above.
    tenantEntries.sort(survivorOrder);
    pairs.push(...partitionPairs(tenantEntries, removed, backing));
  }

  const done = dryRun ? pairs : deletePairs(hippoRoot, pairs, options.actor);
  return { removed: done.length, pairs: done };
}

/** The pairs whose loser was deleted; one store handle, one transaction per delete. */
function deletePairs(hippoRoot: string, pairs: readonly DedupPair[], actor: string | undefined): DedupPair[] {
  const targets = pairs.map((p) => ({ id: p.removed, reason: `dedup: duplicate of ${p.kept}` }));
  const gone = deleteEntriesOneByOne(hippoRoot, targets, { actor, automatic: true });
  return pairs.filter((_, i) => gone[i]);
}
