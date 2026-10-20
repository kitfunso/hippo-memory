import { MemoryEntry, Layer, calculateStrength, createMemory } from '../core/memory.js';
import { tokenize } from '../util/tokenize.js';
import { jaccardMinShared, overlapPartners } from './overlap-index.js';
import { compareEntryIdentity } from '../core/compare.js';
import { duplicateKey, mergedText } from '../util/same-text.js';
import { successorAfterRetirement } from '../core/merged-row.js';
import { rejectionDigest } from '../core/rejection-digest.js';
import { derivationScope, derivationPartitionKey } from '../core/recall-scope.js';
import { jaccardSets } from './conflicts.js';
import { keptAsWritten, type SleepRun } from './run.js';
import { isReusable } from '../core/memory-quality.js';

const MERGE_OVERLAP_THRESHOLD = 0.35; // Jaccard similarity for "related"
const MERGE_MIN_CLUSTER = 2; // minimum cluster size to merge
// with MERGE_MAX_CHARS, keeps a merged row near 500 tokens, a third of the 1,500-token context budget
const MERGE_MAX_SOURCES = 5;
const MERGE_MAX_CHARS = 2000; // total source text; sources past either cap stay unmerged and keep their half-life
// Half-life scale for merged source episodics. Demote via half_life_days: calculateStrength() recomputes live strength
// and never reads the stored field, so a stored-strength write is inert for ranking and overwritten by the next decay
// pass.
const MERGE_SOURCE_HALF_LIFE_FACTOR = 0.3;
// deriveHalfLife grants its high-fit bonus only above 0.7, so a rollup at 0.7 gets none.
const MERGED_SCHEMA_FIT = 0.7;

export function retireHeldTexts(run: SleepRun): void {
  const { survivors } = run;
  // Only a merged row can hold a retired text, so only those are kept, by place, while the rest page past.
  const held: Array<readonly [number, string]> = [];
  for (const [index, row] of survivors.indexed()) {
    if (row.source === 'consolidation' && !row.supersededBy && run.retirable(row)) held.push([index, row.id]);
  }
  // From the last place back, so dropping a survivor never moves one still to come.
  for (let end = held.length; end > 0; end -= run.rows.pageRows) {
    const page = held.slice(Math.max(0, end - run.rows.pageRows), end);
    const rows = new Map(survivors.get(page.map(([, id]) => id)).map((row) => [row.id, row]));
    // Sources come from the store, as the loaded rows did, never from a pass's pending changes.
    const parentIds = [...new Set([...rows.values()].flatMap((r) => r.parents))];
    const sources = new Map(run.rows.read(parentIds).map((s) => [s.id, s]));
    for (const [index, id] of [...page].reverse()) {
      const row = rows.get(id);
      if (row) retireHeldText(run, index, row, sources);
    }
  }
}

function retireHeldText(run: SleepRun, index: number, row: MemoryEntry, sources: ReadonlyMap<string, MemoryEntry>) {
  const rejected = (text: string): boolean => run.tombstones.find(row.tenantId, rejectionDigest(text)) !== null;
  const successor = successorAfterRetirement(row, sources, rejected);
  if (successor === undefined) return;
  run.result.details.push(`  ✂️  ${row.id} held a retired text${successor ? `, ${successor.id} holds the rest` : ''}`);
  if (run.dryRun) return;
  run.pendingDeletes.push(row.id);
  run.units.push(successor ? [row.id, successor.id] : [row.id]);
  if (successor) run.pendingWrites.push(successor);
  run.survivors.replaceAt(index, successor);
}

/** The tenant, scope and origin every row merged out of one partition inherits. */
interface MergePartition {
  tenantId: string;
  scope: ReturnType<typeof derivationScope>;
  origin: MemoryEntry['originProject'];
}

/** One partition's merge candidates, with the token set and length of each: all the overlap join reads. */
interface MergeBucket {
  partition: MergePartition;
  ids: string[];
  lengths: number[];
  sets: Set<string>[];
}

/** The episodic survivors a merge may consume, grouped by the partition their merged row would land in. */
function partitionMergeCandidates(run: SleepRun): Map<string, MergeBucket> {
  const alreadyMergedIds = new Set<string>();
  for (const e of run.survivors.rows()) for (const id of e.parents) alreadyMergedIds.add(id);

  // Partition BEFORE the overlap loop so a cluster can never span tenants and merge cross-tenant content.
  // Map keeps insertion order, so a single-tenant store gets one partition in the original order.
  const buckets = new Map<string, MergeBucket>();
  for (const e of run.survivors.rows()) {
    const candidate =
      e.layer === Layer.Episodic &&
      !e.supersededBy &&
      !keptAsWritten(e) &&
      !alreadyMergedIds.has(e.id) &&
      !e.pinned && // a pin merged with a look-alike would read as one of two values
      isReusable(e);
    const tokens = candidate ? tokenize(e.content) : [];
    // Two empty token sets overlap 1, so tokenless text would merge with any other.
    if (tokens.length === 0) continue;
    const key = derivationPartitionKey(e.tenantId, e.scope, e.originProject);
    let bucket = buckets.get(key);
    if (!bucket) {
      const partition = { tenantId: e.tenantId, scope: derivationScope(e.scope), origin: e.originProject };
      buckets.set(key, (bucket = { partition, ids: [], lengths: [], sets: [] }));
    }
    bucket.ids.push(e.id);
    bucket.lengths.push(e.content.length);
    bucket.sets.push(new Set(tokens));
  }
  return buckets;
}

// 3. Merge pass  - episodic entries only
/** Returns how many clusters were skipped because their merged text matches a rejected value. */
export function mergePass(run: SleepRun): number {
  const used = new Set<string>();
  // The rejection guard reuses the run's one lazily opened tombstone handle; a dry-run never reaches
  // batchWriteAndDelete's guard bypass, so it has nothing to protect there.
  let mergesSkippedRejected = 0;
  for (const bucket of partitionMergeCandidates(run).values()) {
    const { ids, lengths } = bucket;
    const partnersOf = mergePartners(bucket.sets);
    for (let i = 0; i < ids.length; i++) {
      if (used.has(ids[i]) || lengths[i] > MERGE_MAX_CHARS) continue;
      const related = [i, ...partnersOf(i).filter((j) => !used.has(ids[j]))];

      const cluster: number[] = [];
      let clusterChars = 0;
      for (const k of related) {
        if (cluster.length === MERGE_MAX_SOURCES || clusterChars + lengths[k] > MERGE_MAX_CHARS) continue;
        cluster.push(k);
        clusterChars += lengths[k];
      }

      if (cluster.length < MERGE_MIN_CLUSTER) continue;
      const relatedRows = run.survivors.get(related.map((k) => ids[k]));
      const clusterIds = new Set(cluster.map((k) => ids[k]));
      const clusterRows = relatedRows.filter((e) => clusterIds.has(e.id));
      if (!mergeCluster(run, bucket.partition, clusterRows, relatedRows, used)) mergesSkippedRejected++;
    }
  }
  return mergesSkippedRejected;
}

/** Merges one cluster into a semantic row; returns false when a tombstone refuses the merged text. */
function mergeCluster(
  run: SleepRun,
  partition: MergePartition,
  cluster: MemoryEntry[],
  related: MemoryEntry[],
  used: Set<string>,
): boolean {
  const { result, dryRun } = run;
  // Create a semantic summary
  const mergedContent = mergeContents(cluster);

  // Build the semantic entry FIRST (createMemory is cheap and pure) so the tombstone check below runs under the
  // partition's tenant, the one every cluster member shares and the row will land in.
  const semantic = dryRun ? null : semanticSummary(mergedContent, cluster, partition, run.config.defaultHalfLifeDays);

  if (semantic && mergeRejected(run, semantic, cluster, related, used)) return false;

  // Mark cluster members as used
  for (const e of cluster) used.add(e.id);
  result.merged += cluster.length;

  result.details.push(
    `  🔀 merged ${cluster.length} episodic entries into semantic: "${mergedContent.slice(0, 60)}..."`,
  );

  if (!dryRun && semantic) {
    run.pendingWrites.push(semantic);
    run.units.push([semantic.id, ...cluster.map((e) => e.id)]);
    result.semanticCreated++;

    // Scale half_life_days so merged sources decay sooner but stay recoverable; ranking is unchanged on purpose
    // (demoting children regresses QA).
    demoteMergedSources(run, cluster);
  }
  return true;
}

function semanticSummary(
  mergedContent: string,
  cluster: MemoryEntry[],
  partition: MergePartition,
  baseHalfLifeDays: number,
): MemoryEntry {
  const allTags = Array.from(new Set(cluster.flatMap((e) => e.tags))).sort();
  const maxValence = pickStrongestValence(cluster);
  return {
    ...createMemory(mergedContent, {
      layer: Layer.Semantic,
      tags: allTags,
      emotionalValence: maxValence,
      schemaFit: MERGED_SCHEMA_FIT,
      source: 'consolidation',
      confidence: 'inferred',
      tenantId: partition.tenantId,
      scope: partition.scope,
      baseHalfLifeDays,
    }),
    originProject: partition.origin,
    parents: cluster.map((e) => e.id),
  };
}

/** The later conflict check reads the survivors, so it sees the post-demotion half-life. */
function demoteMergedSources(run: SleepRun, cluster: MemoryEntry[]): void {
  const demoted = cluster.map((e) => {
    const row = { ...e, halfLifeDays: Math.max(1, Math.floor(e.halfLifeDays * MERGE_SOURCE_HALF_LIFE_FACTOR)) };
    return { ...row, strength: calculateStrength(row, run.now, run.decayOpts) };
  });
  run.survivors.set(demoted);
  for (const e of demoted) run.pendingWrites.push(e);
}

// mergeContents is deterministic, so a rollup a human already rejected would regenerate each cycle and
// batchWriteAndDelete's guard bypass would re-assert it; this producer-side check makes that bypass safe. A hit skips
// the whole cluster (no demote, no delete) so a later sleep can retry.
function mergeRejected(
  run: SleepRun,
  semantic: MemoryEntry,
  cluster: MemoryEntry[],
  related: MemoryEntry[],
  used: Set<string>,
): boolean {
  const { tombstones } = run;
  const newDigest = rejectionDigest(semantic.content);
  // tombstones from older releases hold this format's digest
  const oldDigest = rejectionDigest(legacyMergeContents(related));
  const newHit = tombstones.find(semantic.tenantId, newDigest);
  const tombstone = newHit ?? tombstones.find(semantic.tenantId, oldDigest);
  const mergeDigest = newHit ? newDigest : oldDigest;
  if (!tombstone) return false;
  // Still mark used: these members are not re-tried against a different cluster in this pass; the next sleep
  // re-clusters them fresh.
  // the old format digested the uncapped list, so rows past the cap were rejected too
  const rejected = newHit ? cluster : related;
  for (const e of rejected) used.add(e.id);
  tombstones.auditOrCount({
    tenantId: semantic.tenantId,
    actor: 'sleep',
    op: 'reject_refusal',
    metadata: {
      digest: mergeDigest,
      reason: tombstone.reason,
      sourceIds: rejected.map((e) => e.id),
    },
  });
  return true;
}

// Helpers

function mergeContents(entries: MemoryEntry[]): string {
  // Each distinct text goes in once and in full (the merge demotes every source), one bullet with its lines indented,
  // so heldTextKeys can read it back.
  // Newest first says which version is current; compareEntryIdentity settles ties, so the row and its rejection digest
  // depend only on the sources.
  const sorted = [...entries].sort(
    (a, b) => Date.parse(b.created) - Date.parse(a.created) || compareEntryIdentity(a, b),
  );
  const texts = new Map<string, string>();
  for (const e of sorted) {
    if (!texts.has(duplicateKey(e.content))) texts.set(duplicateKey(e.content), e.content);
  }
  const header =
    entries.length === 2
      ? '[Consolidated from 2 related memories, newest first]'
      : `[Consolidated pattern from ${entries.length} related memories, newest first]`;
  return mergedText(header, [...texts.values()]);
}

function legacyMergeContents(entries: MemoryEntry[]): string {
  // The old format dropped text, so it is only ever digested to match rejections recorded against it, never written.
  const sorted = [...entries].sort((a, b) => b.content.length - a.content.length || compareEntryIdentity(a, b));
  if (entries.length === 2) return `[Consolidated from ${entries.length} related memories]\n\n${sorted[0].content}`;
  const bullets = sorted.map((e) => `- ${e.content.split('\n')[0].slice(0, 120)}`).join('\n');
  return `[Consolidated pattern from ${entries.length} related memories]\n\n${bullets}`;
}

function pickStrongestValence(entries: MemoryEntry[]): MemoryEntry['emotionalValence'] {
  const order = ['critical', 'negative', 'positive', 'neutral'] as const;
  for (const v of order) {
    if (entries.some((e) => e.emotionalValence === v)) return v;
  }
  return 'neutral';
}

/** Maps i to each j > i, ascending, whose token set overlaps set i to the merge threshold; every set needs at least one
 * token. */
export function mergePartners(sets: readonly Set<string>[]): (i: number) => number[] {
  const candidatesOf = overlapPartners(sets, jaccardMinShared(MERGE_OVERLAP_THRESHOLD));
  return (i) => candidatesOf(i).filter((j) => jaccardSets(sets[i], sets[j]) >= MERGE_OVERLAP_THRESHOLD);
}
