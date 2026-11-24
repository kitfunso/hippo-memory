import {
  createMemory,
  DAG_LEVEL,
  EXTRACTED_TAG,
  Layer,
  type MemoryEntry,
} from '../../base/memory/entry.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { generateDagSummary, type DagSummaryOptions } from './dag-summary.js';
import { rebuildRetryAfter } from './retry-holds.js';
import { overlapPartners } from './overlap-index.js';
import { derivationScope, derivationPartitionKey } from '../../base/scope/recall-scope.js';
import { neverAutoShareTags } from '../sharing/share.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import type { LlmFailure } from '../../base/ports/llm.js';
import type { StoreWith } from '../../base/ports/store.js';
import type { Consolidation } from '../../base/ports/store/consolidation.js';
import { applyRebuild, settleFreshSummary } from './summary-settle.js';

const SUMMARY_FALLBACK_CHARS = 40;
const DEFAULT_REBUILD_CAP = 20;
const CLUSTER_JACCARD_MIN = 0.5;

type DagStore = StoreWith<'consolidation' | 'lessonWrites'>;

/** The summary options plus the config's default half-life, which new summaries start on. */
export type DagBuildOptions = DagSummaryOptions & { baseHalfLifeDays: number; now: Date };

export interface FactCluster {
  label: string;
  members: MemoryEntry[];
  entityTags: string[];
}

export function clusterFacts(facts: MemoryEntry[]): FactCluster[] {
  if (facts.length === 0) return [];

  const entityTags = facts.map((f) =>
    f.tags.filter((t) => t.startsWith('speaker:') || t.startsWith('topic:')),
  );

  const tagSets = entityTags.map((tags) => new Set(tags));
  const partnersOf = overlapPartners(tagSets, () => 1);
  const assigned = new Set<number>();
  const clusters: FactCluster[] = [];

  for (let i = 0; i < facts.length; i++) {
    if (assigned.has(i)) continue;
    const cluster: number[] = [i];
    assigned.add(i);

    for (const j of partnersOf(i)) {
      if (assigned.has(j)) continue;
      const shared = entityTags[i].filter((t) => tagSets[j].has(t)).length;
      const inBoth = [...tagSets[i]].filter((t) => tagSets[j].has(t)).length;
      if (shared / (tagSets[i].size + tagSets[j].size - inBoth) >= CLUSTER_JACCARD_MIN) {
        cluster.push(j);
        assigned.add(j);
      }
    }

    const members = cluster.map((idx) => facts[idx]);
    const sharedTags = entityTags[cluster[0]].filter((t) =>
      cluster.every((idx) => tagSets[idx].has(t)),
    );
    const label =
      sharedTags.map((t) => t.split(':')[1]).join(': ') ||
      members[0].content.slice(0, SUMMARY_FALLBACK_CHARS);

    clusters.push({ label, members, entityTags: sharedTags });
  }

  return clusters;
}

export interface DagBuildResult {
  candidateClusters: number;
  summariesCreated: number;
  factsLinked: number;
  rejected: number;
}

function partitionFactsByTenant(unparented: MemoryEntry[]): Map<string, MemoryEntry[]> {
  const unparentedByTenant = new Map<string, MemoryEntry[]>();
  for (const fact of unparented) {
    const key = derivationPartitionKey(fact.tenantId, fact.scope, fact.originProject);
    const bucket = unparentedByTenant.get(key);
    if (bucket) bucket.push(fact);
    else unparentedByTenant.set(key, [fact]);
  }
  return unparentedByTenant;
}

interface PartitionHome {
  tenantId: string;
  scope: string | null;
  originProject: string | null | undefined;
  baseHalfLifeDays: number;
  now: Date;
}

function createClusterSummaryEntry(
  summary: string,
  cluster: FactCluster,
  home: PartitionHome,
): MemoryEntry {
  const memberCreatedAts = cluster.members.map((m) => m.created).sort();
  const summaryEntry = createMemory(
    summary,
    {
      layer: Layer.Semantic,
      tags: [...cluster.entityTags, ...neverAutoShareTags(cluster.members), 'dag-summary'],
      confidence: 'inferred',
      dagLevel: DAG_LEVEL.topic,
      tenantId: home.tenantId,
      scope: home.scope,
      baseHalfLifeDays: home.baseHalfLifeDays,
    },
    home.now,
  );
  summaryEntry.originProject = home.originProject;
  summaryEntry.descendantCount = cluster.members.length;
  summaryEntry.earliestAt = memberCreatedAts[0];
  summaryEntry.latestAt = memberCreatedAts[memberCreatedAts.length - 1];
  return summaryEntry;
}

interface SummarizeClusterOptions {
  readonly cluster: FactCluster;
  readonly home: PartitionHome;
  readonly opts: DagSummaryOptions;
  readonly result: DagBuildResult;
}

async function summarizeCluster(
  store: DagStore,
  { cluster, home, opts, result }: SummarizeClusterOptions,
): Promise<void> {
  const summary = await generateDagSummary(
    cluster.label,
    cluster.members.map((m) => m.content),
    opts,
  );
  if (!summary) return;

  const summaryEntry = createClusterSummaryEntry(summary, cluster, home);
  try {
    await store.entryWrites.writeEntry({ entry: summaryEntry, actor: CLI_ACTOR });
  } catch (err) {
    if (err instanceof RejectedValueError) {
      result.rejected++;
      log.warn(
        `buildDag: cluster "${cluster.label}" skipped: summary matches a rejected value`,
        errorFields(err),
      );
      return;
    }
    throw err;
  }
  result.summariesCreated++;

  const linked = cluster.members.map((member) => ({ ...member, dagParentId: summaryEntry.id }));
  await store.lessonWrites.writeTogether(linked);
  result.factsLinked += linked.length;
  await settleFreshSummary(store, summaryEntry, 'buildDag', 'buildDag-clean');
}

export async function buildDag(
  store: DagStore,
  facts: MemoryEntry[],
  opts: DagBuildOptions,
): Promise<DagBuildResult> {
  const result: DagBuildResult = {
    candidateClusters: 0,
    summariesCreated: 0,
    factsLinked: 0,
    rejected: 0,
  };
  const { baseHalfLifeDays, now } = opts;

  const unparented = facts.filter(
    (f) => f.dagLevel === DAG_LEVEL.extracted && !f.dagParentId && f.tags.includes(EXTRACTED_TAG),
  );

  for (const [, tenantFacts] of partitionFactsByTenant(unparented)) {
    const home: PartitionHome = {
      tenantId: tenantFacts[0].tenantId,
      scope: derivationScope(tenantFacts[0].scope),
      originProject: tenantFacts[0].originProject,
      baseHalfLifeDays,
      now,
    };
    const clusters = clusterFacts(tenantFacts);
    const eligibleClusters = clusters.filter((c) => c.members.length >= 3);
    result.candidateClusters += eligibleClusters.length;

    for (const cluster of eligibleClusters) {
      await summarizeCluster(store, { cluster, home, opts, result });
    }
  }

  return result;
}

export interface DagRebuildResult {
  attempted: number;
  rebuilt: number;
  refused: number;
  zeroChildSkipped: number;
  failed: number;
  capped: boolean;
  held: number;
}

type CountedFailure = Parameters<NonNullable<Consolidation['noteRebuildFailures']>>[0][number];

interface RebuildOneSummaryOptions {
  store: DagStore;
  summary: MemoryEntry;
  opts: DagSummaryOptions & { now: Date };
  result: DagRebuildResult;
  preloaded: readonly MemoryEntry[];
  rebuiltContent: Map<string, string>;
  failures: number;
  counted: CountedFailure[];
}

async function rebuildOneSummary(options: RebuildOneSummaryOptions): Promise<void> {
  const { store, summary, opts, result, preloaded, rebuiltContent, counted } = options;
  const children = preloaded.map((c) => {
    const content = rebuiltContent.get(c.id);
    return content === undefined ? c : { ...c, content };
  });

  if (children.length === 0) {
    await clearZeroChildSummary(store, summary, result, opts.now);
    return;
  }

  const { text: newContent, providerFailed } = await regenerate(summary, children, opts);

  if (!newContent) {
    result.failed++;
    if (!providerFailed) counted.push(nextFailure(options));
    return;
  }

  const childCreatedAts = children.map((c) => c.created).sort();
  const { changed, refused } = await applyRebuild(store, summary, {
    content: newContent,
    descendantCount: children.length,
    earliestAt: childCreatedAts[0],
    latestAt: childCreatedAts[childCreatedAts.length - 1],
    bumpRebuildCount: true,
    zeroChildren: false,
    actor: 'sleep',
    now: opts.now,
  });
  if (refused) {
    result.refused++;
  } else if (changed) {
    result.rebuilt++;
    rebuiltContent.set(summary.id, newContent);
  }
  // changed=false (refused also false) → race lost; not failure, not success, silently skip
}

async function regenerate(
  summary: MemoryEntry,
  children: readonly MemoryEntry[],
  opts: DagSummaryOptions,
): Promise<{ text: string | null; providerFailed: boolean }> {
  let providerFailed = false;
  const text = await generateDagSummary(
    summaryLabel(summary),
    children.map((c) => c.content),
    {
      ...opts,
      onError: (msg: string, failure?: LlmFailure) => {
        if (failure) providerFailed = true;
        opts.onError?.(msg, failure);
      },
    },
  );
  return { text, providerFailed };
}

function nextFailure({ summary, failures, opts }: RebuildOneSummaryOptions): CountedFailure {
  return {
    id: summary.id,
    tenantId: summary.tenantId,
    priorFailures: failures,
    failures: failures + 1,
    retryAfter: rebuildRetryAfter(failures + 1, opts.now),
  };
}

async function clearZeroChildSummary(
  store: DagStore,
  summary: MemoryEntry,
  result: DagRebuildResult,
  now: Date,
): Promise<void> {
  const { changed } = await applyRebuild(store, summary, {
    content: summary.content,
    descendantCount: 0,
    earliestAt: null,
    latestAt: null,
    bumpRebuildCount: false,
    zeroChildren: true,
    actor: 'sleep',
    now,
  });
  if (changed) result.zeroChildSkipped++;
  // changed=false means race lost or row vanished: skip silently. `refused` is always false here, as only new content
  // is checked against the tombstones.
}

function summaryLabel(summary: MemoryEntry): string {
  const entityTags = summary.tags.filter((t) => t.startsWith('speaker:') || t.startsWith('topic:'));
  return entityTags.length > 0
    ? entityTags.map((t) => t.split(':')[1]).join(': ')
    : summary.content.slice(0, SUMMARY_FALLBACK_CHARS);
}

/** Sleep-cycle phase draining the dirty L2 summary queue; one throwing rebuild does not abort
 * the rest. A concurrent sleep's second writer gets changed=false (UPDATE requires
 * summary_dirty=1) and is skipped silently; a tombstone hit counts as `refused`. */
export async function rebuildDirtySummaries(
  store: DagStore,
  opts: DagSummaryOptions & { cap?: number; now: Date },
): Promise<DagRebuildResult> {
  const cap = opts.cap ?? DEFAULT_REBUILD_CAP;
  const {
    summaries: queue,
    more,
    held,
  } = await store.consolidation.dirtySummaries(cap, opts.now.toISOString());

  const result: DagRebuildResult = {
    attempted: queue.length,
    rebuilt: 0,
    refused: 0,
    zeroChildSkipped: 0,
    failed: 0,
    capped: more,
    held: held ?? 0,
  };

  const rebuiltContent = new Map<string, string>();
  const counted: CountedFailure[] = [];
  for (const [index, { summary, children, failures }] of queue.entries()) {
    if (index > 0 && index % 25 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await rebuildIsolated({
      store,
      summary,
      opts,
      result,
      preloaded: children,
      rebuiltContent,
      failures: failures ?? 0,
      counted,
    });
  }
  await noteFailedRebuilds(store, counted);

  return result;
}

async function noteFailedRebuilds(
  store: DagStore,
  counted: readonly CountedFailure[],
): Promise<void> {
  if (counted.length === 0) return;
  try {
    await store.consolidation.noteRebuildFailures?.(counted);
  } catch (err) {
    log.warn(
      `rebuildDirtySummaries: noting ${counted.length} failed rebuilds failed: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

async function rebuildIsolated(options: RebuildOneSummaryOptions): Promise<void> {
  const { summary, result, counted } = options;
  try {
    await rebuildOneSummary(options);
  } catch (err) {
    result.failed++;
    counted.push(nextFailure(options));
    log.error(
      `rebuildDirtySummaries: summary ${summary.id} (tenant ${summary.tenantId}) failed: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

export interface EntityProfilesBuildResult {
  candidateClusters: number;
  profilesCreated: number;
  l2sLinked: number;
  failed: number;
  rejected: number;
}

function createProfileEntry(
  summary: string,
  cluster: FactCluster,
  home: PartitionHome,
): MemoryEntry {
  const memberCreatedAts = cluster.members.map((m) => m.created).sort();
  const nowIso = home.now.toISOString();
  const profileEntry = createMemory(
    summary,
    {
      layer: Layer.Semantic,
      tags: [...cluster.entityTags, ...neverAutoShareTags(cluster.members), 'dag-entity-profile'],
      confidence: 'inferred',
      dagLevel: DAG_LEVEL.entity,
      tenantId: home.tenantId,
      scope: home.scope,
      baseHalfLifeDays: home.baseHalfLifeDays,
    },
    home.now,
  );
  profileEntry.originProject = home.originProject;
  profileEntry.descendantCount = cluster.members.length;
  profileEntry.earliestAt = memberCreatedAts[0];
  profileEntry.latestAt = memberCreatedAts[memberCreatedAts.length - 1];
  profileEntry.dagLevel3BuiltAt = nowIso;
  return profileEntry;
}

interface ProfileClusterOptions {
  readonly cluster: FactCluster;
  readonly home: PartitionHome;
  readonly opts: DagSummaryOptions;
  readonly result: EntityProfilesBuildResult;
}

async function profileCluster(
  store: DagStore,
  { cluster, home, opts, result }: ProfileClusterOptions,
): Promise<void> {
  const summary = await generateDagSummary(
    cluster.label,
    cluster.members.map((m) => m.content),
    opts,
  );
  if (!summary) {
    result.failed++;
    return;
  }

  const profileEntry = createProfileEntry(summary, cluster, home);
  try {
    await store.entryWrites.writeEntry({ entry: profileEntry, actor: CLI_ACTOR });
  } catch (err) {
    if (err instanceof RejectedValueError) {
      result.rejected++;
      log.warn(
        `buildEntityProfiles: cluster "${cluster.label}" skipped: profile matches a rejected value`,
        errorFields(err),
      );
      return;
    }
    throw err;
  }
  result.profilesCreated++;

  const linked = cluster.members.map((member) => ({ ...member, dagParentId: profileEntry.id }));
  await store.lessonWrites.writeTogether(linked);
  result.l2sLinked += linked.length;
  await settleFreshSummary(store, profileEntry, 'buildEntityProfiles', 'buildEntityProfiles-clean');
}

/** Build L3 entity profiles by clustering L2 summaries sharing entity tags (2+ L2s per entity).
 * Each L2 link write marks the new L3 dirty, so clear it or the same cycle re-rebuilds it. */
export async function buildEntityProfiles(
  store: DagStore,
  l2Summaries: MemoryEntry[],
  opts: DagBuildOptions,
): Promise<EntityProfilesBuildResult> {
  const result: EntityProfilesBuildResult = {
    candidateClusters: 0,
    profilesCreated: 0,
    l2sLinked: 0,
    failed: 0,
    rejected: 0,
  };
  const { baseHalfLifeDays, now } = opts;

  const unparented = l2Summaries.filter((s) => s.dagLevel === DAG_LEVEL.topic && !s.dagParentId);

  for (const [, tenantL2s] of partitionFactsByTenant(unparented)) {
    const home: PartitionHome = {
      tenantId: tenantL2s[0].tenantId,
      scope: derivationScope(tenantL2s[0].scope),
      originProject: tenantL2s[0].originProject,
      baseHalfLifeDays,
      now,
    };
    const clusters = clusterFacts(tenantL2s);
    const eligible = clusters.filter((c) => c.members.length >= 2);
    result.candidateClusters += eligible.length;

    for (const cluster of eligible) {
      await profileCluster(store, { cluster, home, opts, result });
    }
  }

  return result;
}
