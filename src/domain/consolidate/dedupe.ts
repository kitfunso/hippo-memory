/**
 * Store-level dedup: same text apart from spacing, keeping the stronger copy; split out so `api.sleep` can dedupe
 * without cli -> api imports.
 * Survivor order is total and tenant-scoped: strength bucket, retrievalCount, then compareEntryIdentity; raw and
 * superseded rows are not candidates.
 */

import { textOverlap } from '../../base/util/tokenize.js';
import { compareEntryIdentity } from '../../base/rank/compare.js';
import { canAutoDelete, type MemoryEntry } from '../../base/memory/memory.js';
import { derivationPartitionKey } from '../../base/scope/recall-scope.js';
import { duplicateKey } from '../../base/util/same-text.js';
import type { StoreWith } from '../../store/port.js';

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

/**
 * Quantization step for strength-tie comparisons: the 0.01 epsilon applied by rounding instead of an abs-diff
 * threshold, so the tiebreak is transitive.
 */
const STRENGTH_TIE_EPSILON = 0.01;

/**
 * Quantize strength to an integer bucket so ties are a true equivalence relation (equal iff same multiple of
 * `STRENGTH_TIE_EPSILON`).
 * Non-finite input maps to 0: a NaN bucket would make the comparator return NaN and break the total order. */
export function strengthBucket(strength: number | null | undefined): number {
  const s = strength ?? 0;
  return Number.isFinite(s) ? Math.round(s / STRENGTH_TIE_EPSILON) : 0;
}

// finiteCount hardens the retrieval leg like strengthBucket: a NaN would break the total order.
// Unreachable via the schema (non-nullable INTEGER column); kept for symmetry.
const finiteCount = (n: number | null | undefined): number => (Number.isFinite(n ?? 0) ? (n ?? 0) : 0);

/** What the survivor order and a pair read of a row: a scan holds these, never the row itself. */
interface DedupRow {
  readonly id: string;
  readonly content: string;
  readonly layer: MemoryEntry['layer'];
  readonly strength: number;
  readonly retrievalCount: number;
  readonly tags: readonly string[];
  readonly source: string;
  /** canAutoDelete's answer; whether the row backs an object is asked once, for the losers only. */
  readonly deletable: boolean;
}

function dedupRow(entry: MemoryEntry): DedupRow {
  const { id, content, layer, strength, retrievalCount, tags, source } = entry;
  return { id, content, layer, strength, retrievalCount, tags, source, deletable: canAutoDelete(entry) };
}

/** The v1.26.3 survivor total order: strength bucket desc, then retrievalCount desc, then compareEntryIdentity. */
function survivorOrder(a: DedupRow, b: DedupRow): number {
  const bucketDiff = strengthBucket(b.strength) - strengthBucket(a.strength);
  if (bucketDiff !== 0) return bucketDiff;
  const retrievalDiff = finiteCount(b.retrievalCount) - finiteCount(a.retrievalCount);
  if (retrievalDiff !== 0) return retrievalDiff;
  return compareEntryIdentity(a, b);
}

function dedupPair(kept: DedupRow, dropped: DedupRow): DedupPair {
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

/** One partition's same-text groups by duplicateKey: the best row so far and the rows it beat that may go. */
type PartitionGroups = Map<string, { survivor: DedupRow; losers: DedupRow[] }>;

// The survivor order is total, so the best row so far ends as the row a sorted pass puts first, and every other
// deletable row ends a loser whichever order the rows came in.
function addRow(groups: PartitionGroups, key: string, row: DedupRow): void {
  const group = groups.get(key);
  if (!group) {
    groups.set(key, { survivor: row, losers: [] });
    return;
  }
  const beaten = survivorOrder(row, group.survivor) < 0 ? group.survivor : row;
  if (beaten !== row) group.survivor = row;
  if (beaten.deletable) group.losers.push(beaten);
}

/** One partition's pairs in a sorted pass's order: groups by their survivor's rank, each group's losers by rank; a
 * loser backing an object stays. */
function partitionPairs(groups: PartitionGroups, backing: ReadonlySet<string>): DedupPair[] {
  return [...groups.values()]
    .map((group) => ({ ...group, losers: group.losers.filter((loser) => !backing.has(loser.id)) }))
    .filter((group) => group.losers.length > 0)
    .sort((a, b) => survivorOrder(a.survivor, b.survivor))
    .flatMap((group) => group.losers.sort(survivorOrder).map((loser) => dedupPair(group.survivor, loser)));
}

/** The rows duplicateCandidates selects, picked from pages of every row. */
const isCurrentDistilled = (e: MemoryEntry): boolean => (e.kind ?? 'distilled') === 'distilled' && !e.supersededBy;

type Partitions = Map<string, PartitionGroups>;

/** Pages of rows, held now or read a page at a time from the store. */
type RowPages = Iterable<readonly MemoryEntry[]> | AsyncIterable<readonly MemoryEntry[]>;

/** Groups rows fed a page at a time; between pages only each group's survivor and losers are held. Map order is first
 * appearance, so partitions keep the order the pages gave them. */
async function partitionRows(pages: RowPages): Promise<Partitions> {
  const partitions: Partitions = new Map();
  for await (const page of pages) {
    for (const entry of page) {
      if (!isCurrentDistilled(entry)) continue;
      // EI2: also split by restricted scope, else a private copy can delete the readable one.
      const partition = derivationPartitionKey(entry.tenantId, entry.scope, entry.originProject);
      let groups = partitions.get(partition);
      if (!groups) partitions.set(partition, (groups = new Map()));
      addRow(groups, duplicateKey(entry.content), dedupRow(entry));
    }
  }
  return partitions;
}

/** The candidates' partitions in the order a read of every current row first meets them. */
async function candidatePartitions(store: StoreWith<'consolidation'>): Promise<Partitions> {
  const { rows, firstSeen } = await store.consolidation.duplicateCandidates();
  const rank = new Map<string, number>();
  firstSeen.forEach((seen, i) => {
    const key = derivationPartitionKey(seen.tenantId, seen.scope, seen.originProject);
    if (!rank.has(key)) rank.set(key, i);
  });
  const at = (key: string): number => rank.get(key) ?? firstSeen.length;
  return new Map([...(await partitionRows([rows]))].sort(([a], [b]) => at(a) - at(b)));
}

async function scanPairs(store: StoreWith<'consolidation'>, partitions: Partitions): Promise<DedupPair[]> {
  const losers = [...partitions.values()].flatMap((groups) => [...groups.values()].flatMap((g) => g.losers));
  const backing = await store.consolidation.objectBackedAmong(losers.map((loser) => loser.id));
  return [...partitions.values()].flatMap((groups) => partitionPairs(groups, backing));
}

/** Remove the weaker copy of same-text (apart from spacing) memories within one tenant, never across (isolation).
 * Strength wins, then retrievals; `threshold` is ignored; `pages` feeds every row in place of the candidates read. */
export async function deduplicateStore(
  store: StoreWith<'consolidation'>,
  options: { threshold?: number; dryRun?: boolean; actor?: string; pages?: RowPages } = {},
): Promise<DedupResult> {
  // Only current distilled rows compete: raw rows are append-only (the delete trigger would abort sleep mid-loop) and
  // superseded rows are history.
  const partitions = options.pages ? await partitionRows(options.pages) : await candidatePartitions(store);
  const pairs = await scanPairs(store, partitions);
  const done = options.dryRun ? pairs : await deletePairs(store, pairs, options.actor);
  return { removed: done.length, pairs: done };
}

/** The pairs whose loser was deleted; one store call, one transaction per batch of deletes. */
async function deletePairs(
  store: StoreWith<'consolidation'>,
  pairs: readonly DedupPair[],
  actor: string | undefined,
): Promise<DedupPair[]> {
  const targets = pairs.map((p) => ({ id: p.removed, reason: `dedup: duplicate of ${p.kept}` }));
  const gone = await store.consolidation.deleteInBatches(targets, { actor, automatic: true });
  return pairs.filter((_, i) => gone[i]);
}
