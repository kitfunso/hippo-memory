import { MemoryEntry, Layer, createMemory } from '../../base/memory/entry.js';
import { calculateStrength } from '../../base/memory/strength.js';
import { jaccardSets, tokenize } from '../../base/util/tokenize.js';
import { jaccardMinShared, overlapPartners } from './overlap-index.js';
import { compareEntryIdentity } from '../../base/rank/compare.js';
import { duplicateKey, heldTexts, mergedText } from '../../base/util/same-text.js';
import { successorAfterRetirement } from '../../base/memory/merged-row.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import {
  derivationScope,
  derivationPartitionKey,
  isPersonalScope,
} from '../../base/scope/recall-scope.js';
import { INSTRUCTION_LIKE_TAG, instructionIn } from '../trust/instruction-detect.js';
import { keptAsWritten, type SleepRun } from './run.js';
import { isReusable } from '../../base/memory/memory-quality.js';
import { isSuperseded } from '../../base/memory/liveness.js';

const MERGE_OVERLAP_THRESHOLD = 0.35;
const MERGE_MIN_CLUSTER = 2;
const MERGE_MAX_SOURCES = 5;
const MERGE_DETAIL_PREVIEW_CHARS = 60;
const LEGACY_BULLET_CHARS = 120;
const MERGE_MAX_CHARS = 2000;
const MERGE_SOURCE_HALF_LIFE_FACTOR = 0.3;
const MERGED_SCHEMA_FIT = 0.7;

export async function retireHeldTexts(run: SleepRun): Promise<void> {
  const { survivors } = run;
  const held: Array<readonly [number, string]> = [];
  for await (const [index, row] of survivors.indexed()) {
    if (row.source === 'consolidation' && !isSuperseded(row) && run.retirable(row)) {
      held.push([index, row.id]);
    }
  }
  for (let end = held.length; end > 0; end -= run.rows.pageRows) {
    const page = held.slice(Math.max(0, end - run.rows.pageRows), end);
    const rows = new Map(
      (await survivors.get(page.map(([, id]) => id))).map((row) => [row.id, row]),
    );
    const parentIds = [...new Set([...rows.values()].flatMap((r) => r.parents))];
    const sources = new Map((await run.rows.read(parentIds)).map((s) => [s.id, s]));
    const rejected = await rejectedAmongPage(run, [...rows.values()], sources);
    for (const [index, id] of [...page].reverse()) {
      const row = rows.get(id);
      if (row) retireHeldText({ run, index, row, sources, rejected });
    }
  }
}

interface RetireHeldTextOptions {
  readonly run: SleepRun;
  readonly index: number;
  readonly row: MemoryEntry;
  readonly sources: ReadonlyMap<string, MemoryEntry>;
  readonly rejected: ReadonlyMap<string, ReadonlySet<string>>;
}

function retireHeldText({ run, index, row, sources, rejected }: RetireHeldTextOptions): void {
  const digests = rejected.get(row.tenantId);
  const successor = successorAfterRetirement(
    row,
    sources,
    (text) => digests?.has(rejectionDigest(text)) === true,
  );
  if (successor === undefined) return;
  run.result.events.push({
    kind: 'retiredText',
    id: row.id,
    successorId: successor ? successor.id : null,
  });
  if (run.dryRun) return;
  run.pendingDeletes.push(row.id);
  run.units.push(successor ? [row.id, successor.id] : [row.id]);
  if (successor) run.pendingWrites.push(successor);
  run.survivors.replaceAt(index, successor);
}

function askedTexts(row: MemoryEntry, sources: ReadonlyMap<string, MemoryEntry>): string[] {
  if (row.source !== 'consolidation' || isSuperseded(row)) return [];
  const live = row.parents.flatMap((id) => {
    const source = sources.get(id);
    return source && !isSuperseded(source) ? [source.content] : [];
  });
  return [...new Set([...live, ...heldTexts(row)])];
}

async function rejectedAmongPage(
  run: SleepRun,
  rows: readonly MemoryEntry[],
  sources: ReadonlyMap<string, MemoryEntry>,
): Promise<Map<string, ReadonlySet<string>>> {
  const asked = new Map<string, string[]>();
  for (const row of rows) {
    const digests = asked.get(row.tenantId) ?? [];
    digests.push(...askedTexts(row, sources).map(rejectionDigest));
    asked.set(row.tenantId, digests);
  }
  const rejected = new Map<string, ReadonlySet<string>>();
  for (const [tenantId, digests] of asked) {
    rejected.set(tenantId, await run.tombstones.rejectedAmong(tenantId, digests));
  }
  return rejected;
}

interface MergePartition {
  tenantId: string;
  scope: ReturnType<typeof derivationScope>;
  origin: MemoryEntry['originProject'];
}

interface MergeBucket {
  partition: MergePartition;
  ids: string[];
  lengths: number[];
  sets: Set<string>[];
}

async function partitionMergeCandidates(run: SleepRun): Promise<Map<string, MergeBucket>> {
  const alreadyMergedIds = new Set<string>();
  for await (const e of run.survivors.rows()) for (const id of e.parents) alreadyMergedIds.add(id);

  const buckets = new Map<string, MergeBucket>();
  for await (const e of run.survivors.rows()) {
    const candidate =
      e.layer === Layer.Episodic &&
      !isSuperseded(e) &&
      !keptAsWritten(e) &&
      !alreadyMergedIds.has(e.id) &&
      !e.pinned &&
      !e.leadIn &&
      isReusable(e);
    const tokens = candidate ? tokenize(e.content) : [];
    if (tokens.length === 0) continue;
    const key = derivationPartitionKey(e.tenantId, e.scope, e.originProject);
    let bucket = buckets.get(key);
    if (!bucket) {
      const partition = {
        tenantId: e.tenantId,
        scope: derivationScope(e.scope),
        origin: e.originProject,
      };
      buckets.set(key, (bucket = { partition, ids: [], lengths: [], sets: [] }));
    }
    bucket.ids.push(e.id);
    bucket.lengths.push(e.content.length);
    bucket.sets.push(new Set(tokens));
  }
  return buckets;
}

/** Returns how many clusters were skipped because their merged text matches a rejected value. */
export async function mergePass(run: SleepRun): Promise<number> {
  const used = new Set<string>();
  let mergesSkippedRejected = 0;
  for (const bucket of (await partitionMergeCandidates(run)).values()) {
    const { ids, lengths } = bucket;
    const partnersOf = mergePartners(bucket.sets);
    for (let i = 0; i < ids.length; i++) {
      if (used.has(ids[i]) || lengths[i] > MERGE_MAX_CHARS) continue;
      const related = [i, ...partnersOf(i).filter((j) => !used.has(ids[j]))];

      const cluster: number[] = [];
      let clusterChars = 0;
      for (const k of related) {
        if (cluster.length === MERGE_MAX_SOURCES || clusterChars + lengths[k] > MERGE_MAX_CHARS) {
          continue;
        }
        cluster.push(k);
        clusterChars += lengths[k];
      }

      if (cluster.length < MERGE_MIN_CLUSTER) continue;
      const relatedRows = await run.survivors.get(related.map((k) => ids[k]));
      const clusterIds = new Set(cluster.map((k) => ids[k]));
      const clusterRows = relatedRows.filter((e) => clusterIds.has(e.id));
      if (
        !(await mergeCluster({
          run,
          partition: bucket.partition,
          cluster: clusterRows,
          related: relatedRows,
          used,
        }))
      ) {
        mergesSkippedRejected++;
      }
    }
  }
  return mergesSkippedRejected;
}

interface MergeClusterOptions {
  readonly run: SleepRun;
  readonly partition: MergePartition;
  readonly cluster: MemoryEntry[];
  readonly related: MemoryEntry[];
  readonly used: Set<string>;
}

async function mergeCluster({
  run,
  partition,
  cluster,
  related,
  used,
}: MergeClusterOptions): Promise<boolean> {
  const { result, dryRun } = run;
  const mergedContent = mergeContents(cluster);

  const semantic = semanticSummary(mergedContent, cluster, partition, run);

  if (await mergeRejected({ run, semantic, cluster, related, used })) return false;

  for (const e of cluster) used.add(e.id);
  result.merged += cluster.length;

  result.events.push({
    kind: 'merged',
    count: cluster.length,
    preview: mergedContent.slice(0, MERGE_DETAIL_PREVIEW_CHARS),
  });

  if (!dryRun) {
    run.pendingWrites.push(semantic);
    run.units.push([semantic.id, ...cluster.map((e) => e.id)]);
    result.semanticCreated++;

    await demoteMergedSources(run, cluster);
  }
  return true;
}

function semanticSummary(
  mergedContent: string,
  cluster: MemoryEntry[],
  partition: MergePartition,
  run: Pick<SleepRun, 'config' | 'now'>,
): MemoryEntry {
  const allTags = mergedTags(mergedContent, cluster, partition.scope);
  const maxValence = pickStrongestValence(cluster);
  return {
    ...createMemory(
      mergedContent,
      {
        layer: Layer.Semantic,
        tags: allTags,
        emotionalValence: maxValence,
        schemaFit: MERGED_SCHEMA_FIT,
        source: 'consolidation',
        confidence: 'inferred',
        tenantId: partition.tenantId,
        scope: partition.scope,
        baseHalfLifeDays: run.config.defaultHalfLifeDays,
      },
      run.now,
    ),
    originProject: partition.origin,
    parents: cluster.map((e) => e.id),
  };
}

function mergedTags(
  mergedContent: string,
  cluster: readonly MemoryEntry[],
  scope: MergePartition['scope'],
): string[] {
  const tags = Array.from(new Set(cluster.flatMap((e) => e.tags))).sort();
  if (isPersonalScope(scope) || tags.includes(INSTRUCTION_LIKE_TAG)) return tags;
  return instructionIn({ content: mergedContent }, tags).flagged
    ? [...tags, INSTRUCTION_LIKE_TAG].sort()
    : tags;
}

async function demoteMergedSources(run: SleepRun, cluster: MemoryEntry[]): Promise<void> {
  const demoted = cluster.map((e) => {
    const row = {
      ...e,
      halfLifeDays: Math.max(1, Math.floor(e.halfLifeDays * MERGE_SOURCE_HALF_LIFE_FACTOR)),
    };
    return { ...row, strength: calculateStrength(row, run.now, run.strength, run.decayOpts) };
  });
  await run.survivors.set(demoted);
  for (const e of demoted) run.pendingWrites.push(e);
}

interface MergeRejectedOptions {
  readonly run: SleepRun;
  readonly semantic: MemoryEntry;
  readonly cluster: MemoryEntry[];
  readonly related: MemoryEntry[];
  readonly used: Set<string>;
}

async function mergeRejected({
  run,
  semantic,
  cluster,
  related,
  used,
}: MergeRejectedOptions): Promise<boolean> {
  const { tombstones } = run;
  const newDigest = rejectionDigest(semantic.content);
  const oldDigest = rejectionDigest(legacyMergeContents(related));
  const newHit = await tombstones.find(semantic.tenantId, newDigest);
  const tombstone = newHit ?? (await tombstones.find(semantic.tenantId, oldDigest));
  const mergeDigest = newHit ? newDigest : oldDigest;
  if (!tombstone) return false;
  const rejected = newHit ? cluster : related;
  for (const e of rejected) used.add(e.id);
  await tombstones.auditOrCount({
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

function mergeContents(entries: MemoryEntry[]): string {
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
  const sorted = [...entries].sort(
    (a, b) => b.content.length - a.content.length || compareEntryIdentity(a, b),
  );
  if (entries.length === 2) {
    return `[Consolidated from ${entries.length} related memories]\n\n${sorted[0].content}`;
  }
  const bullets = sorted
    .map((e) => `- ${e.content.split('\n')[0].slice(0, LEGACY_BULLET_CHARS)}`)
    .join('\n');
  return `[Consolidated pattern from ${entries.length} related memories]\n\n${bullets}`;
}

function pickStrongestValence(entries: MemoryEntry[]): MemoryEntry['emotionalValence'] {
  const order = ['critical', 'negative', 'positive', 'neutral'] as const;
  for (const v of order) {
    if (entries.some((e) => e.emotionalValence === v)) return v;
  }
  return 'neutral';
}

/** Maps i to each j > i, ascending, whose token set overlaps set i to the merge threshold; every
 * set needs at least one token. */
export function mergePartners(sets: readonly Set<string>[]): (i: number) => number[] {
  const candidatesOf = overlapPartners(sets, jaccardMinShared(MERGE_OVERLAP_THRESHOLD));
  return (i) =>
    candidatesOf(i).filter((j) => jaccardSets(sets[i], sets[j]) >= MERGE_OVERLAP_THRESHOLD);
}
