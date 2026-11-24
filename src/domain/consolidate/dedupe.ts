import { textOverlap } from '../../base/util/tokenize.js';
import { compareEntryIdentity } from '../../base/rank/compare.js';
import { canAutoDelete } from '../../base/memory/keep-rules.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { derivationPartitionKey } from '../../base/scope/recall-scope.js';
import { duplicateKey, identityText } from '../../base/util/same-text.js';
import type { StoreWith } from '../../base/ports/store.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { isSuperseded } from '../../base/memory/liveness.js';

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

const STRENGTH_TIE_EPSILON = 0.01;

/**
 * Quantize strength to an integer bucket so ties are a true equivalence relation (equal iff same
 * multiple of `STRENGTH_TIE_EPSILON`). Non-finite input maps to 0: a NaN bucket would make the
 * comparator return NaN and break the total order. */
export function strengthTieKey(strength: number | null | undefined): number {
  const s = strength ?? 0;
  return Number.isFinite(s) ? Math.round(s / STRENGTH_TIE_EPSILON) : 0;
}

interface DedupRow {
  readonly id: string;
  readonly content: string;
  readonly layer: MemoryEntry['layer'];
  readonly strength: number;
  readonly retrievalCount: number;
  readonly tags: readonly string[];
  readonly source: string;
  readonly deletable: boolean;
}

function dedupRow(entry: MemoryEntry): DedupRow {
  const { id, content, layer, strength, retrievalCount, tags, source } = entry;
  return {
    id,
    content,
    layer,
    strength,
    retrievalCount,
    tags,
    source,
    deletable: canAutoDelete(entry),
  };
}

function survivorOrder(a: DedupRow, b: DedupRow): number {
  const bucketDiff = strengthTieKey(b.strength) - strengthTieKey(a.strength);
  if (bucketDiff !== 0) return bucketDiff;
  const retrievalDiff = b.retrievalCount - a.retrievalCount;
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

type PartitionGroups = Map<string, { survivor: DedupRow; losers: DedupRow[] }>;

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

function partitionPairs(groups: PartitionGroups, backing: ReadonlySet<string>): DedupPair[] {
  return [...groups.values()]
    .map((group) => ({ ...group, losers: group.losers.filter((loser) => !backing.has(loser.id)) }))
    .filter((group) => group.losers.length > 0)
    .sort((a, b) => survivorOrder(a.survivor, b.survivor))
    .flatMap((group) =>
      group.losers.sort(survivorOrder).map((loser) => dedupPair(group.survivor, loser)),
    );
}

const isCurrentDistilled = (e: MemoryEntry): boolean =>
  (e.kind ?? 'distilled') === 'distilled' && !isSuperseded(e);

type Partitions = Map<string, PartitionGroups>;

type RowPages = Iterable<readonly MemoryEntry[]> | AsyncIterable<readonly MemoryEntry[]>;

async function partitionRows(pages: RowPages): Promise<Partitions> {
  const partitions: Partitions = new Map();
  for await (const page of pages) {
    for (const entry of page) {
      if (!isCurrentDistilled(entry)) continue;
      const partition = derivationPartitionKey(entry.tenantId, entry.scope, entry.originProject);
      let groups = partitions.get(partition);
      if (!groups) partitions.set(partition, (groups = new Map()));
      addRow(groups, duplicateKey(identityText(entry)), dedupRow(entry));
    }
  }
  return partitions;
}

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

async function scanPairs(
  store: StoreWith<'consolidation' | 'auditMaintenance'>,
  partitions: Partitions,
): Promise<DedupPair[]> {
  const losers = [...partitions.values()].flatMap((groups) =>
    [...groups.values()].flatMap((g) => g.losers),
  );
  const backing = await store.auditMaintenance.objectBackedAmong(losers.map((loser) => loser.id));
  return [...partitions.values()].flatMap((groups) => partitionPairs(groups, backing));
}

/** Remove the weaker copy of same-text (apart from spacing) memories within one tenant, never
 * across (isolation). Strength wins, then retrievals; `threshold` is ignored; `pages` feeds
 * every row in place of the candidates read. */
export async function deduplicateStore(
  store: StoreWith<'consolidation' | 'auditMaintenance'>,
  options: { threshold?: number; dryRun?: boolean; actor?: string; pages?: RowPages } = {},
): Promise<DedupResult> {
  const partitions = options.pages
    ? await partitionRows(options.pages)
    : await candidatePartitions(store);
  const pairs = await scanPairs(store, partitions);
  const done = options.dryRun ? pairs : await deletePairs(store, pairs, options.actor);
  return { removed: done.length, pairs: done };
}

async function deletePairs(
  store: StoreWith<'consolidation' | 'auditMaintenance'>,
  pairs: readonly DedupPair[],
  actor: string | undefined,
): Promise<DedupPair[]> {
  const targets = pairs.map((p) => ({ id: p.removed, reason: `dedup: duplicate of ${p.kept}` }));
  const gone = new Set(
    await store.auditMaintenance.deleteAutomatically(targets, actor ?? CLI_ACTOR),
  );
  return pairs.filter((p) => gone.delete(p.removed));
}
