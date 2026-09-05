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

import { textOverlap } from './search.js';
import { loadAllEntries, deleteEntry } from './store.js';
import { compareEntryIdentity } from './compare.js';
import type { MemoryEntry } from './memory.js';

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

/**
 * Scan the store for near-duplicate memories and remove the weaker copy.
 * Two memories are duplicates if their content has > threshold Jaccard
 * overlap AND they belong to the same tenant: the scan is partitioned by
 * tenantId, so byte-identical content in two tenants is never a duplicate
 * pair (the tenant boundary is an isolation boundary; cross-tenant removal
 * was the v1.32.0 known-issue data-loss bug).
 * Keeps the one with higher strength (or more retrievals if tied).
 */
export function deduplicateStore(
  hippoRoot: string,
  options: { threshold?: number; dryRun?: boolean } = {}
): DedupResult {
  const threshold = options.threshold ?? 0.7;
  const dryRun = options.dryRun ?? false;
  // Only current distilled rows compete: raw rows are append-only (the delete
  // trigger would abort sleep mid-loop) and superseded rows are history, as in consolidate.ts.
  const entries = loadAllEntries(hippoRoot).filter((e) => e.kind === 'distilled' && !e.superseded_by);

  // Tenant partition (mirrors consolidate.ts mergeCandidatesByTenant and
  // dag.ts unparentedByTenant): group by tenantId BEFORE the sort so a
  // duplicate pair can never form across tenants. Map preserves insertion
  // order, so a single-tenant store (every row 'default') gets exactly one
  // group and the sort plus pair loop below run byte-identical to the
  // pre-fix global pass.
  const entriesByTenant = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const bucket = entriesByTenant.get(entry.tenantId);
    if (bucket) bucket.push(entry);
    else entriesByTenant.set(entry.tenantId, [entry]);
  }

  // finiteCount mirrors strengthBucket's non-finite hardening on the
  // retrieval leg: a NaN retrieval_count would make the comparator return
  // NaN and break the total order the same way a NaN bucket would.
  // Unreachable via the schema (non-nullable INTEGER column), so this is
  // symmetry, not a live bug.
  const finiteCount = (n: number | null | undefined): number =>
    Number.isFinite(n ?? 0) ? (n ?? 0) : 0;

  // Shared across tenant groups: safe because memory ids are globally
  // unique (crypto.randomUUID at creation), so an id in `removed` can never
  // collide with another tenant's row, and deleteEntry below deletes by
  // primary-key id alone.
  const removed = new Set<string>();
  const pairs: DedupPair[] = [];

  for (const tenantEntries of entriesByTenant.values()) {
    // The v1.26.3 survivor total order (see the file-level docstring:
    // strength bucket desc -> retrieval_count desc -> compareEntryIdentity),
    // scoped per tenant group: the total order holds within a tenant only,
    // matching the partition above.
    tenantEntries.sort((a, b) => {
      const bucketDiff = strengthBucket(b.strength) - strengthBucket(a.strength);
      if (bucketDiff !== 0) return bucketDiff;
      const retrievalDiff = finiteCount(b.retrieval_count) - finiteCount(a.retrieval_count);
      if (retrievalDiff !== 0) return retrievalDiff;
      return compareEntryIdentity(a, b);
    });

    for (let i = 0; i < tenantEntries.length; i++) {
      if (removed.has(tenantEntries[i].id)) continue;
      for (let j = i + 1; j < tenantEntries.length; j++) {
        if (removed.has(tenantEntries[j].id)) continue;

        const similarity = textOverlap(tenantEntries[i].content, tenantEntries[j].content);
        if (similarity <= threshold) continue;

        removed.add(tenantEntries[j].id);
        pairs.push({
          kept: tenantEntries[i].id,
          keptContent: tenantEntries[i].content,
          keptLayer: tenantEntries[i].layer,
          keptStrength: tenantEntries[i].strength ?? 0,
          removed: tenantEntries[j].id,
          removedContent: tenantEntries[j].content,
          removedLayer: tenantEntries[j].layer,
          removedStrength: tenantEntries[j].strength ?? 0,
          similarity,
        });
      }
    }
  }

  if (!dryRun) {
    for (const id of removed) {
      deleteEntry(hippoRoot, id);
    }
  }

  return { removed: removed.size, pairs };
}
