/**
 * Store-level deduplication. Scans for memories with the same text apart
 * from spacing, keeps the stronger copy (by strength + retrieval count),
 * removes the rest.
 *
 * Extracted from cli.ts in Episode A (v1.11.3) so `api.sleep` can dedupe
 * during the consolidation pipeline without violating the cli -> api
 * dependency direction. `handleDedup` in cli.ts continues to import and use
 * this function unchanged.
 *
 * Survivor selection is a total order as of v1.26.3
 * (docs/plans/2026-07-16-dedupe-survivor-determinism.md): strength bucket
 * desc -> retrieval_count desc -> compareEntryIdentity (content asc ->
 * layer rank -> tags -> source -> id asc; the metadata keys arrived in
 * v1.38.1, docs/plans/2026-09-04-dedupe-survivor-metadata.md). Previously
 * the strength/retrieval-count comparator could tie exactly with no terminal
 * key, so the survivor fell to load order (arrival-order-dependent); see
 * `strengthBucket` below for the bucket encoding. As of the tenant-partition
 * fix (docs/plans/2026-08-15-dedupe-tenant-partition.md) the order is scoped
 * WITHIN each tenant group; cross-tenant pairs are never compared. Raw and
 * superseded rows are not candidates at all (v1.38.1).
 */

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

// finiteCount mirrors strengthBucket's non-finite hardening on the
// retrieval leg: a NaN retrieval_count would make the comparator return
// NaN and break the total order the same way a NaN bucket would.
// Unreachable via the schema (non-nullable INTEGER column), so this is
// symmetry, not a live bug.
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

// Tenant partition (mirrors consolidate.ts mergeCandidatesByTenant and
// dag.ts unparentedByTenant): group by tenantId BEFORE the sort so a
// duplicate pair can never form across tenants. Map preserves insertion
// order, so a single-tenant store (every row 'default') gets exactly one
// group and the sort plus pair loop below run byte-identical to the
// pre-fix global pass.
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

/**
 * Scan the store for duplicates and remove the weaker copy: same text apart
 * from spacing, since a near-duplicate can differ in a value (port, version,
 * path, name), AND the same tenant: the scan is partitioned by
 * tenantId, so byte-identical content in two tenants is never a duplicate
 * pair (the tenant boundary is an isolation boundary; cross-tenant removal
 * was the v1.32.0 known-issue data-loss bug).
 * Keeps the one with higher strength (or more retrievals if tied). `threshold` is accepted for old callers and ignored.
 */
export function deduplicateStore(
  hippoRoot: string,
  options: { threshold?: number; dryRun?: boolean; actor?: string } = {}
): DedupResult {
  const dryRun = options.dryRun ?? false;
  // Only current distilled rows compete: raw rows are append-only (the delete
  // trigger would abort sleep mid-loop) and superseded rows are history, as in consolidate.ts.
  const entries = loadCurrentDistilledEntries(hippoRoot);
  const entriesByTenant = entriesByPartition(entries);

  // Shared across tenant groups: safe because memory ids are globally
  // unique (crypto.randomUUID at creation), so an id in `removed` can never
  // collide with another tenant's row, and deleteEntry below deletes by
  // primary-key id alone.
  const removed = new Set<string>();
  const pairs: DedupPair[] = [];
  const backing = memoriesBackingObjects(hippoRoot);

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
