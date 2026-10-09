import { createMemory, Layer, type MemoryEntry } from './memory.js';
import { writeEntry, writeEntriesTogether } from './store/entry-writes.js';
import {
  loadAllDirtySummaries,
  loadChildrenOfSummary,
  applyRebuildResult,
  clearSummaryDirtyAfterBuild,
} from './store/summaries.js';
import { RejectedValueError } from './store/rejection.js';
import { redactSecretsStrict } from './secret-detect.js';
import { describeMessageFailure, sendAnthropicMessage } from './util/anthropic-messages.js';
import { derivationScope, derivationPartitionKey } from './recall-scope.js';
import { loadConfig } from './config.js';
import { neverAutoShareTags } from './shared.js';
import { errorMessage, log } from './log.js';
import { certainDefect } from './memory-quality.js';

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

  const assigned = new Set<number>();
  const clusters: FactCluster[] = [];

  for (let i = 0; i < facts.length; i++) {
    if (assigned.has(i)) continue;
    const cluster: number[] = [i];
    assigned.add(i);

    for (let j = i + 1; j < facts.length; j++) {
      if (assigned.has(j)) continue;
      const shared = entityTags[i].filter((t) => entityTags[j].includes(t));
      const union = new Set([...entityTags[i], ...entityTags[j]]);
      const jaccard = union.size > 0 ? shared.length / union.size : 0;
      if (jaccard >= 0.5) {
        cluster.push(j);
        assigned.add(j);
      }
    }

    const members = cluster.map((idx) => facts[idx]);
    const sharedTags = entityTags[cluster[0]].filter((t) =>
      cluster.every((idx) => entityTags[idx].includes(t)),
    );
    const label = sharedTags
      .map((t) => t.split(':')[1])
      .join(': ') || members[0].content.slice(0, 40);

    clusters.push({ label, members, entityTags: sharedTags });
  }

  return clusters;
}

export interface DagSummaryOptions {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
  onError?: (msg: string) => void;
}

const DAG_SUMMARY_PROMPT = `You are summarizing a cluster of facts about a specific topic/entity for a memory system.

Topic: {label}
Facts:
{facts}

Write a single concise paragraph (2-4 sentences) that captures all the key information from these facts. This summary will be used to quickly determine if this cluster is relevant to a future query, so include specific names, dates, numbers, and key details. Output ONLY the summary paragraph, no preamble.`;

// Output budget for one summary paragraph, and the shortest reply kept as a summary.
const SUMMARY_MAX_TOKENS = 400;
const SUMMARY_MIN_CHARS = 20;

export async function generateDagSummary(
  label: string,
  factContents: string[],
  opts: DagSummaryOptions,
): Promise<string | null> {
  const factsBlock = factContents.map((f, i) => `${i + 1}. ${redactSecretsStrict(f)}`).join('\n');
  const prompt = DAG_SUMMARY_PROMPT
    .replace('{label}', redactSecretsStrict(label))
    .replace('{facts}', factsBlock);

  const reply = await sendAnthropicMessage({
    apiKey: opts.apiKey,
    model: opts.model,
    maxTokens: SUMMARY_MAX_TOKENS,
    prompt,
    fetcher: opts.fetcher,
  });
  if (!reply.ok) {
    opts.onError?.(describeMessageFailure(reply.failure));
    return null;
  }

  const defect = certainDefect(reply.text);
  if (defect !== null) {
    opts.onError?.(`summary quality refused: ${defect}`);
    return null;
  }
  return reply.text.length >= SUMMARY_MIN_CHARS ? reply.text : null;
}

export interface DagBuildResult {
  candidateClusters: number;
  summariesCreated: number;
  factsLinked: number;
  /** Clusters skipped because the summary matched a rejected value. Re-parenting writes are
   *  guard-exempt (same id + content), so only summary-creation refusals count. */
  rejected: number;
}

// Partition BEFORE clustering so one LLM summary never mixes facts from different tenants.
// Map keeps insertion order, so a single-tenant store iterates in its original order.
// buildEntityProfiles partitions its L2s with this same key.
function partitionFactsByTenant(unparented: MemoryEntry[]): Map<string, MemoryEntry[]> {
  const unparentedByTenant = new Map<string, MemoryEntry[]>();
  for (const fact of unparented) {
    const key = derivationPartitionKey(fact.tenantId, fact.scope, fact.origin_project);
    const bucket = unparentedByTenant.get(key);
    if (bucket) bucket.push(fact);
    else unparentedByTenant.set(key, [fact]);
  }
  return unparentedByTenant;
}

/** Where one partition's derived rows land: its members' own tenant, scope and project. */
interface PartitionHome {
  tenantId: string;
  scope: string | null;
  originProject: string | null | undefined;
  baseHalfLifeDays: number;
}

/** The L2 summary entry for one cluster, landing in the facts' own tenant and scope. */
function createClusterSummaryEntry(summary: string, cluster: FactCluster, home: PartitionHome): MemoryEntry {
  const memberCreatedAts = cluster.members.map((m) => m.created).sort();
  // Every member of `cluster` shares home.tenantId by construction (the
  // tenant partition above), so the summary lands in the same tenant
  // as the facts it summarizes instead of always 'default'
  // (memory.ts:535 defaults tenantId when the option is omitted).
  const summaryEntry = createMemory(summary, {
    layer: Layer.Semantic,
    tags: [...cluster.entityTags, ...neverAutoShareTags(cluster.members), 'dag-summary'],
    confidence: 'inferred',
    dag_level: 2,
    tenantId: home.tenantId,
    scope: home.scope,
    baseHalfLifeDays: home.baseHalfLifeDays,
  });
  summaryEntry.origin_project = home.originProject;
  // Cache descendant_count + earliest/latest_at on the summary row so
  // DAG-aware recall can reason about scope without walking the children.
  summaryEntry.descendant_count = cluster.members.length;
  summaryEntry.earliest_at = memberCreatedAts[0];
  summaryEntry.latest_at = memberCreatedAts[memberCreatedAts.length - 1];
  return summaryEntry;
}

/** Summarize one eligible cluster, write the summary, then re-parent its members under it. */
async function summarizeCluster(
  hippoRoot: string,
  cluster: FactCluster,
  home: PartitionHome,
  opts: DagSummaryOptions,
  result: DagBuildResult,
): Promise<void> {
  const summary = await generateDagSummary(
    cluster.label,
    cluster.members.map((m) => m.content),
    opts,
  );
  if (!summary) return;

  const summaryEntry = createClusterSummaryEntry(summary, cluster, home);
  // A refused summary skips only this cluster. writeEntry's guard reads tenantId off the entry
  // (home.tenantId), so it already checks this tenant's tombstones: no separate check here.
  try {
    writeEntry(hippoRoot, summaryEntry);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      result.rejected++;
      log.warn(`buildDag: cluster "${cluster.label}" skipped: summary matches a rejected value`);
      return;
    }
    throw err;
  }
  result.summariesCreated++;

  result.factsLinked += writeEntriesTogether(hippoRoot, cluster.members.map((member) => ({ ...member, dag_parent_id: summaryEntry.id })));
  // Member writes just marked this fresh summary dirty; clear it, or the same sleep cycle's
  // rebuild pass would re-rebuild every new summary at twice the LLM cost.
  clearSummaryDirtyAfterBuild(hippoRoot, summaryEntry.id, summaryEntry.tenantId, 'buildDag');
}

export async function buildDag(
  hippoRoot: string,
  facts: MemoryEntry[],
  opts: DagSummaryOptions,
): Promise<DagBuildResult> {
  const result: DagBuildResult = { candidateClusters: 0, summariesCreated: 0, factsLinked: 0, rejected: 0 };
  const baseHalfLifeDays = loadConfig(hippoRoot).defaultHalfLifeDays;

  const unparented = facts.filter(
    (f) => f.dag_level === 1 && !f.dag_parent_id && f.tags.includes('extracted'),
  );

  for (const [, tenantFacts] of partitionFactsByTenant(unparented)) {
    const home: PartitionHome = {
      tenantId: tenantFacts[0].tenantId,
      scope: derivationScope(tenantFacts[0].scope),
      originProject: tenantFacts[0].origin_project,
      baseHalfLifeDays,
    };
    const clusters = clusterFacts(tenantFacts);
    const eligibleClusters = clusters.filter((c) => c.members.length >= 3);
    result.candidateClusters += eligibleClusters.length;

    for (const cluster of eligibleClusters) {
      await summarizeCluster(hippoRoot, cluster, home, opts, result);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// rebuildDirtySummaries orchestrator
// ---------------------------------------------------------------------------

export interface DagRebuildResult {
  attempted: number;            // summaries we tried (<= cap)
  rebuilt: number;              // successful regenerations
  refused: number;              // tombstone-hit refusals: dirty cleared, content NOT written
  zeroChildSkipped: number;     // dirty-cleared without LLM (descendants all gone)
  failed: number;               // LLM null, fetch error, or applyRebuildResult throw
  capped: boolean;              // true if queue had more than cap entries
}

/** Regenerate one dirty summary from its children and tally the outcome; throws reach the caller's isolation. */
async function rebuildOneSummary(
  hippoRoot: string,
  summary: MemoryEntry,
  opts: DagSummaryOptions,
  result: DagRebuildResult,
): Promise<void> {
  const children = loadChildrenOfSummary(hippoRoot, summary.id, summary.tenantId);

  if (children.length === 0) {
    clearZeroChildSummary(hippoRoot, summary, result);
    return;
  }

  const newContent = await generateDagSummary(
    summaryLabel(summary),
    children.map((c) => c.content),
    opts,
  );

  if (!newContent) {
    // LLM null / fetch error → leave dirty for next cycle
    result.failed++;
    return;
  }

  const childCreatedAts = children.map((c) => c.created).sort();
  const { changed, refused } = applyRebuildResult(hippoRoot, summary, {
    content: newContent,
    descendant_count: children.length,
    earliest_at: childCreatedAts[0],
    latest_at: childCreatedAts[childCreatedAts.length - 1],
    bumpRebuildCount: true,
    zeroChildren: false,
    actor: 'sleep',
  });
  if (refused) {
    result.refused++;
  } else if (changed) {
    result.rebuilt++;
  }
  // changed=false (refused also false) → race lost; not failure, not
  // success, silently skip
}

/** Zero-child case: clear dirty + zero counts, no LLM call, no rebuild_count bump. */
function clearZeroChildSummary(hippoRoot: string, summary: MemoryEntry, result: DagRebuildResult): void {
  const { changed } = applyRebuildResult(hippoRoot, summary, {
    content: summary.content,
    descendant_count: 0,
    earliest_at: null,
    latest_at: null,
    bumpRebuildCount: false,
    zeroChildren: true,
    actor: 'sleep',
  });
  if (changed) result.zeroChildSkipped++;
  // changed=false → race lost / row vanished; silently skip. `refused`
  // is always false here — applyRebuildResult only checks the
  // tombstone when bumpRebuildCount is true (store/summaries.ts).
}

// Derive label from summary's existing entity tags (mirrors clusterFacts)
function summaryLabel(summary: MemoryEntry): string {
  const entityTags = summary.tags.filter(
    (t) => t.startsWith('speaker:') || t.startsWith('topic:'),
  );
  return entityTags.length > 0
    ? entityTags.map((t) => t.split(':')[1]).join(': ')
    : summary.content.slice(0, 40);
}

/**
 * Sleep-cycle phase that drains the dirty L2 summary queue.
 * Thin orchestrator; the heavy lifting lives in store.ts (load + apply)
 * and dag.ts:generateDagSummary (LLM call).
 *
 * Per-summary try/catch: one throwing rebuild does NOT abort the rest of the queue.
 *
 * Race-loser handling: applyRebuildResult's UPDATE WHERE includes
 * AND summary_dirty=1, so concurrent sleep's second writer returns
 * changed=false. Silent skip (neither rebuilt++ nor refused++ nor failed++).
 *
 * A tombstone hit counts as `refused`, not `rebuilt`; dirty clears either way.
 */
export async function rebuildDirtySummaries(
  hippoRoot: string,
  opts: DagSummaryOptions & { cap?: number },
): Promise<DagRebuildResult> {
  const cap = opts.cap ?? 20;
  const dirty = loadAllDirtySummaries(hippoRoot);
  const capped = dirty.length > cap;
  const queue = dirty.slice(0, cap);

  const result: DagRebuildResult = {
    attempted: queue.length,
    rebuilt: 0,
    refused: 0,
    zeroChildSkipped: 0,
    failed: 0,
    capped,
  };

  for (const [index, summary] of queue.entries()) {
    // Yield the macrotask queue every 25 summaries. The cap can reach 1000,
    // and each iteration is synchronous SQLite (the LLM await resolves as a
    // microtask when the response is cached/mocked), so a large batch would
    // otherwise starve timers and IPC for the whole rebuild: server
    // keep-alive pings in production, Vitest's birpc heartbeat in tests
    // (hardcoded 60s upstream, vitest-dev/vitest#8164).
    if (index > 0 && index % 25 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    try {
      await rebuildOneSummary(hippoRoot, summary, opts, result);
    } catch (err) {
      // One throw doesn't abort the queue; log enough to triage an exotic
      // failure (SQLite I/O, prepare), since audit() already catches its own.
      result.failed++;
      log.error(
        `rebuildDirtySummaries: summary ${summary.id} (tenant ${summary.tenantId}) failed: ${
          errorMessage(err)
        }`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// L3 entity profile build path
// ---------------------------------------------------------------------------

export interface EntityProfilesBuildResult {
  candidateClusters: number;
  profilesCreated: number;
  l2sLinked: number;
  // Lets operators see LLM null / rate-limit / 401 failures (parity with DagRebuildResult.failed).
  failed: number;
  /** Clusters skipped because the profile matched a rejected value. Kept apart from
   *  `failed`: a tombstone hit is a deliberate refusal, not an error. */
  rejected: number;
}

/** The L3 profile entry for one cluster of L2 summaries. */
function createProfileEntry(summary: string, cluster: FactCluster, home: PartitionHome): MemoryEntry {
  const memberCreatedAts = cluster.members.map((m) => m.created).sort();
  const nowIso = new Date().toISOString();
  const profileEntry = createMemory(summary, {
    layer: Layer.Semantic,
    tags: [...cluster.entityTags, ...neverAutoShareTags(cluster.members), 'dag-entity-profile'],
    confidence: 'inferred',
    dag_level: 3,
    tenantId: home.tenantId,
    scope: home.scope,
    baseHalfLifeDays: home.baseHalfLifeDays,
  });
  profileEntry.origin_project = home.originProject;
  profileEntry.descendant_count = cluster.members.length;
  profileEntry.earliest_at = memberCreatedAts[0];
  profileEntry.latest_at = memberCreatedAts[memberCreatedAts.length - 1];
  profileEntry.dag_level_3_built_at = nowIso;
  return profileEntry;
}

/** Profile one eligible cluster of L2s, write it, then re-link the L2s under it. */
async function profileCluster(
  hippoRoot: string,
  cluster: FactCluster,
  home: PartitionHome,
  opts: DagSummaryOptions,
  result: EntityProfilesBuildResult,
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
  // A refused profile skips only this cluster; the re-linking below never runs for it.
  try {
    writeEntry(hippoRoot, profileEntry);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      result.rejected++;
      log.warn(`buildEntityProfiles: cluster "${cluster.label}" skipped: profile matches a rejected value`);
      return;
    }
    throw err;
  }
  result.profilesCreated++;

  result.l2sLinked += writeEntriesTogether(hippoRoot, cluster.members.map((member) => ({ ...member, dag_parent_id: profileEntry.id })));
  // Re-linking just marked the fresh L3 dirty; clear it so this cycle's rebuild skips it.
  // The distinct source tags the audit row.
  clearSummaryDirtyAfterBuild(
    hippoRoot,
    profileEntry.id,
    home.tenantId,
    'buildEntityProfiles',
    'buildEntityProfiles-clean',
  );
}

/**
 * Build L3 entity profiles by clustering L2 summaries with
 * shared entity tags. Threshold 2+ L2s per entity. Mirrors buildDag L1->L2
 * pattern, one level up.
 *
 * Born-dirty cancellation: each L2 link write marks the new L3 dirty, so clear it
 * or the same sleep cycle's rebuild re-rebuilds the freshly built L3.
 */
export async function buildEntityProfiles(
  hippoRoot: string,
  l2Summaries: MemoryEntry[],
  opts: DagSummaryOptions,
): Promise<EntityProfilesBuildResult> {
  const result: EntityProfilesBuildResult = {
    candidateClusters: 0,
    profilesCreated: 0,
    l2sLinked: 0,
    failed: 0,
    rejected: 0,
  };
  const baseHalfLifeDays = loadConfig(hippoRoot).defaultHalfLifeDays;

  // Only L2 with no L3 parent yet (avoid re-clustering already-profiled L2s).
  const unparented = l2Summaries.filter(
    (s) => s.dag_level === 2 && !s.dag_parent_id,
  );

  for (const [, tenantL2s] of partitionFactsByTenant(unparented)) {
    const home: PartitionHome = {
      tenantId: tenantL2s[0].tenantId,
      scope: derivationScope(tenantL2s[0].scope),
      originProject: tenantL2s[0].origin_project,
      baseHalfLifeDays,
    };
    const clusters = clusterFacts(tenantL2s);
    const eligible = clusters.filter((c) => c.members.length >= 2);
    result.candidateClusters += eligible.length;

    for (const cluster of eligible) {
      await profileCluster(hippoRoot, cluster, home, opts, result);
    }
  }

  return result;
}
