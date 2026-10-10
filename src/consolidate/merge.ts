import { MemoryEntry, Layer, calculateStrength, createMemory } from '../core/memory.js';
import { tokenize } from '../util/tokenize.js';
import { jaccardMinShared, overlapPartners } from './overlap-index.js';
import { compareEntryIdentity } from '../core/compare.js';
import { duplicateKey, mergedText } from '../util/same-text.js';
import { successorAfterRetirement } from '../util/merged-row.js';
import { rejectionDigest } from '../store/rejection.js';
import { reportAuditWriteFailure } from '../store/audit.js';
import { derivationScope, derivationPartitionKey } from '../store/recall-scope.js';
import { jaccardSets } from './conflicts.js';
import { keptAsWritten, type SleepRun } from './run.js';
import { isReusable } from '../core/memory-quality.js';

const MERGE_OVERLAP_THRESHOLD = 0.35;  // Jaccard similarity for "related"
const MERGE_MIN_CLUSTER = 2;            // minimum cluster size to merge
const MERGE_MAX_SOURCES = 5;            // with MERGE_MAX_CHARS, keeps a merged row near 500 tokens, a third of the 1,500-token context budget
const MERGE_MAX_CHARS = 2000;           // total source text; sources past either cap stay unmerged and keep their half-life
// Half-life scale for merged source episodics. Demote via half_life_days: calculateStrength() recomputes live strength and never reads the stored field,
// so a stored-strength write is inert for ranking and overwritten by the next decay pass.
const MERGE_SOURCE_HALF_LIFE_FACTOR = 0.3;

export function retireHeldTexts(run: SleepRun): void {
  const { survivors } = run;
  const byId = new Map(run.all.map((e) => [e.id, e]));
  const rejectedIn = (tenantId: string) => (text: string): boolean =>
    run.tombstones.find(tenantId, rejectionDigest(text)) !== null;
  for (let i = survivors.length - 1; i >= 0; i--) {
    const row = survivors[i];
    const successor = run.retirable(row) ? successorAfterRetirement(row, byId, rejectedIn(row.tenantId)) : undefined;
    if (successor === undefined) continue;
    run.result.details.push(`  ✂️  ${row.id} held a retired text${successor ? `, ${successor.id} holds the rest` : ''}`);
    if (run.dryRun) continue;
    run.pendingDeletes.push(row.id);
    run.units.push(successor ? [row.id, successor.id] : [row.id]);
    if (successor) {
      run.pendingWrites.push(successor);
      survivors[i] = successor;
    } else {
      survivors.splice(i, 1);
    }
  }
}

/** The tenant, scope and origin every row merged out of one partition inherits. */
interface MergePartition {
  tenantId: string;
  scope: ReturnType<typeof derivationScope>;
  origin: MemoryEntry['origin_project'];
}

/** The episodic survivors a merge may consume, grouped by the partition their merged row would land in. */
function partitionMergeCandidates(survivors: readonly MemoryEntry[]): Map<string, MemoryEntry[]> {
  const alreadyMergedIds = new Set(survivors.flatMap((e) => e.parents));
  const mergeCandidates = survivors.filter(
    (e) => e.layer === Layer.Episodic && !e.superseded_by && !keptAsWritten(e) && !alreadyMergedIds.has(e.id)
      && !e.pinned // a pin merged with a look-alike would read as one of two values
      && tokenize(e.content).length > 0 // two empty token sets overlap 1, so tokenless text would merge with any other
      && isReusable(e),
  );

  // Partition BEFORE the overlap loop so a cluster can never span tenants and merge cross-tenant content.
  // Map keeps insertion order, so a single-tenant store gets one partition in the original order.
  const mergeCandidatesByTenant = new Map<string, MemoryEntry[]>();
  for (const entry of mergeCandidates) {
    const key = derivationPartitionKey(entry.tenantId, entry.scope, entry.origin_project);
    const bucket = mergeCandidatesByTenant.get(key);
    if (bucket) bucket.push(entry);
    else mergeCandidatesByTenant.set(key, [entry]);
  }
  return mergeCandidatesByTenant;
}

// 3. Merge pass  - episodic entries only
/** Returns how many clusters were skipped because their merged text matches a rejected value. */
export function mergePass(run: SleepRun): number {
  const used = new Set<string>();
  const mergeCandidatesByTenant = partitionMergeCandidates(run.survivors);

  // The rejection guard reuses the run's one lazily opened tombstone handle; a dry-run
  // never reaches batchWriteAndDelete's guard bypass, so it has nothing to protect there.
  let mergesSkippedRejected = 0;
  for (const [, tenantCandidates] of mergeCandidatesByTenant) {
    const partition: MergePartition = {
      tenantId: tenantCandidates[0].tenantId,
      scope: derivationScope(tenantCandidates[0].scope),
      origin: tenantCandidates[0].origin_project,
    };
    const partnersOf = mergePartners(tenantCandidates.map((e) => e.content));
    for (let i = 0; i < tenantCandidates.length; i++) {
      if (used.has(tenantCandidates[i].id) || tenantCandidates[i].content.length > MERGE_MAX_CHARS) continue;

      const related: MemoryEntry[] = [tenantCandidates[i]];

      for (const j of partnersOf(i)) {
        if (!used.has(tenantCandidates[j].id)) related.push(tenantCandidates[j]);
      }

      const cluster: MemoryEntry[] = [];
      let clusterChars = 0;
      for (const e of related) {
        if (cluster.length === MERGE_MAX_SOURCES || clusterChars + e.content.length > MERGE_MAX_CHARS) continue;
        cluster.push(e);
        clusterChars += e.content.length;
      }

      if (cluster.length < MERGE_MIN_CLUSTER) continue;
      if (!mergeCluster(run, partition, cluster, related, used)) mergesSkippedRejected++;
    }
  }
  return mergesSkippedRejected;
}

/** Merges one cluster into a semantic row; returns false when a tombstone refuses the merged text. */
function mergeCluster(run: SleepRun, partition: MergePartition, cluster: MemoryEntry[], related: MemoryEntry[], used: Set<string>): boolean {
  const { result, dryRun } = run;
  // Create a semantic summary
  const mergedContent = mergeContents(cluster);

  // Build the semantic entry FIRST (createMemory is cheap and pure) so the tombstone check below runs
  // under the partition's tenant, the one every cluster member shares and the row will land in.
  const semantic = dryRun ? null : semanticSummary(mergedContent, cluster, partition, run.config.defaultHalfLifeDays);

  if (semantic && mergeRejected(run, semantic, cluster, related, used)) return false;

  // Mark cluster members as used
  for (const e of cluster) used.add(e.id);
  result.merged += cluster.length;

  result.details.push(
    `  🔀 merged ${cluster.length} episodic entries into semantic: "${mergedContent.slice(0, 60)}..."`
  );

  if (!dryRun && semantic) {
    run.pendingWrites.push(semantic);
    run.units.push([semantic.id, ...cluster.map((e) => e.id)]);
    result.semanticCreated++;

    // Scale half_life_days so merged sources decay sooner but stay recoverable; ranking is unchanged on purpose (demoting children regresses QA).
    // Mutate in place: `cluster` shares references with `survivors`, and the later detectConflicts(survivors) must see the post-demotion half-life.
    demoteMergedSources(run, cluster);
  }
  return true;
}

function semanticSummary(mergedContent: string, cluster: MemoryEntry[], partition: MergePartition, baseHalfLifeDays: number): MemoryEntry {
  const allTags = Array.from(new Set(cluster.flatMap((e) => e.tags))).sort();
  const maxValence = pickStrongestValence(cluster);
  return {
    ...createMemory(mergedContent, {
      layer: Layer.Semantic,
      tags: allTags,
      emotional_valence: maxValence,
      schema_fit: 0.7,
      source: 'consolidation',
      confidence: 'inferred',
      tenantId: partition.tenantId,
      scope: partition.scope,
      baseHalfLifeDays,
    }),
    origin_project: partition.origin,
    parents: cluster.map((e) => e.id),
  };
}

function demoteMergedSources(run: SleepRun, cluster: MemoryEntry[]): void {
  for (const e of cluster) {
    e.half_life_days = Math.max(1, Math.floor(e.half_life_days * MERGE_SOURCE_HALF_LIFE_FACTOR));
    e.strength = calculateStrength(e, run.now, run.decayOpts);
    run.pendingWrites.push(e);
  }
}

// mergeContents is deterministic, so a rollup a human already rejected would regenerate each cycle and batchWriteAndDelete's guard bypass would re-assert it;
// this producer-side check makes that bypass safe. A hit skips the whole cluster (no demote, no delete) so a later sleep can retry.
function mergeRejected(run: SleepRun, semantic: MemoryEntry, cluster: MemoryEntry[], related: MemoryEntry[], used: Set<string>): boolean {
  const { tombstones } = run;
  const newDigest = rejectionDigest(semantic.content);
  const oldDigest = rejectionDigest(legacyMergeContents(related)); // tombstones from older releases hold this format's digest
  const newHit = tombstones.find(semantic.tenantId, newDigest);
  const tombstone = newHit ?? tombstones.find(semantic.tenantId, oldDigest);
  const mergeDigest = newHit ? newDigest : oldDigest;
  if (!tombstone) return false;
  // Still mark used: these members are not re-tried against a different cluster in this pass; the next sleep re-clusters them fresh.
  const rejected = newHit ? cluster : related; // the old format digested the uncapped list, so rows past the cap were rejected too
  for (const e of rejected) used.add(e.id);
  try {
    tombstones.audit({
      tenantId: semantic.tenantId,
      actor: 'sleep',
      op: 'reject_refusal',
      metadata: {
        digest: mergeDigest,
        reason: tombstone.reason,
        sourceIds: rejected.map((e) => e.id),
      },
    });
  } catch (error) {
    reportAuditWriteFailure('reject_refusal', String(error));
  }
  return true;
}

// Helpers

function mergeContents(entries: MemoryEntry[]): string {
  // Each distinct text goes in once and in full (the merge demotes every source), one bullet with its lines indented, so heldTextKeys can read it back.
  // Newest first says which version is current; compareEntryIdentity settles ties, so the row and its rejection digest depend only on the sources.
  const sorted = [...entries].sort((a, b) => (Date.parse(b.created) - Date.parse(a.created)) || compareEntryIdentity(a, b));
  const texts = new Map<string, string>();
  for (const e of sorted) {
    if (!texts.has(duplicateKey(e.content))) texts.set(duplicateKey(e.content), e.content);
  }
  const header = entries.length === 2
    ? '[Consolidated from 2 related memories, newest first]'
    : `[Consolidated pattern from ${entries.length} related memories, newest first]`;
  return mergedText(header, [...texts.values()]);
}

function legacyMergeContents(entries: MemoryEntry[]): string {
  // The old format dropped text, so it is only ever digested to match rejections recorded against it, never written.
  const sorted = [...entries].sort((a, b) => (b.content.length - a.content.length) || compareEntryIdentity(a, b));
  if (entries.length === 2) return `[Consolidated from ${entries.length} related memories]\n\n${sorted[0].content}`;
  const bullets = sorted.map((e) => `- ${e.content.split('\n')[0].slice(0, 120)}`).join('\n');
  return `[Consolidated pattern from ${entries.length} related memories]\n\n${bullets}`;
}

function pickStrongestValence(entries: MemoryEntry[]): MemoryEntry['emotional_valence'] {
  const order = ['critical', 'negative', 'positive', 'neutral'] as const;
  for (const v of order) {
    if (entries.some((e) => e.emotional_valence === v)) return v;
  }
  return 'neutral';
}

/** Maps i to each j > i, ascending, whose text overlap with i reaches the merge threshold; every text needs at least one token. */
export function mergePartners(contents: readonly string[]): (i: number) => number[] {
  const sets = contents.map((text) => new Set(tokenize(text)));
  const candidatesOf = overlapPartners(sets, jaccardMinShared(MERGE_OVERLAP_THRESHOLD));
  return (i) => candidatesOf(i).filter((j) => jaccardSets(sets[i], sets[j]) >= MERGE_OVERLAP_THRESHOLD);
}
