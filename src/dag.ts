import { createMemory, Layer, type MemoryEntry } from './memory.js';
import {
  writeEntry,
  loadAllDirtySummaries,
  loadChildrenOfSummary,
  applyRebuildResult,
  clearSummaryDirtyAfterBuild,
} from './store.js';
import { compressContents } from './consolidate.js';

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
}

const DAG_SUMMARY_PROMPT = `You are summarizing a cluster of facts about a specific topic/entity for a memory system.

Topic: {label}
Facts:
{facts}

Write a single concise paragraph (2-4 sentences) that captures all the key information from these facts. This summary will be used to quickly determine if this cluster is relevant to a future query, so include specific names, dates, numbers, and key details. Output ONLY the summary paragraph, no preamble.`;

export async function generateDagSummary(
  label: string,
  factContents: string[],
  opts: DagSummaryOptions,
): Promise<string | null> {
  const model = opts.model ?? 'claude-sonnet-4-6';
  const fetchFn = opts.fetcher ?? fetch;

  const factsBlock = factContents.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const prompt = DAG_SUMMARY_PROMPT
    .replace('{label}', label)
    .replace('{facts}', factsBlock);

  let res: Response;
  try {
    res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  try {
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = data.content?.[0]?.text?.trim() ?? '';
    return text.length >= 20 ? text : null;
  } catch {
    return null;
  }
}

export interface DagBuildResult {
  candidateClusters: number;
  summariesCreated: number;
  factsLinked: number;
}

/**
 * Shared DAG summary node-creation helper (extracted from buildDag).
 *
 * NODE-CREATION ONLY — does NOT generate summary text; the caller supplies
 * `content` (buildDag passes its LLM `generateDagSummary` output; the merge
 * pass passes the zero-dep extractive compressor output). Responsibilities:
 *   - write a Layer.Semantic summary at dag_level=2 with the 'dag-summary' tag
 *   - link each child's dag_parent_id to the summary (children keep dag_level=0
 *     when they come from the merge pass; buildDag's children are dag_level=1)
 *   - cache descendant_count + earliest_at/latest_at from the children's sorted
 *     `created` timestamps
 *   - clear the born-dirty flag (E3 cancellation, same as buildDag)
 *
 * DETERMINISM: the summary's `created`/`last_retrieved`/`valid_from` are stamped
 * from the MAX child `created` timestamp, never `Date.now()`, so a consolidation
 * over a fixed input set is byte-identical across runs. createMemory() stamps
 * wall-clock by default; we overwrite those three fields here.
 */
export function createDagSummaryNode(
  hippoRoot: string,
  opts: {
    content: string;
    children: MemoryEntry[];
    tenantId?: string;
    createdAt?: string;
    /** Provenance for rebuildDirtySummaries dispatch. The merge pass passes
     *  'consolidation' (rebuild via zero-dep compressor); buildDag omits it
     *  (createMemory default → rebuild via LLM). */
    source?: string;
  },
): MemoryEntry {
  const { content, children } = opts;
  // entity tags shared by ALL children (mirrors clusterFacts label derivation)
  const childEntityTags = children.map((c) =>
    c.tags.filter((t) => t.startsWith('speaker:') || t.startsWith('topic:')),
  );
  const sharedEntityTags = children.length > 0
    ? childEntityTags[0].filter((t) => children.every((_, i) => childEntityTags[i].includes(t)))
    : [];

  // Sorted child `created` timestamps drive both the cached scope columns AND
  // the deterministic stamp. Byte compare is chronological for canonical ISO.
  const childCreatedAts = children.map((c) => c.created).sort();
  const stamp = opts.createdAt
    ?? (childCreatedAts.length > 0
      ? childCreatedAts[childCreatedAts.length - 1]
      : new Date().toISOString());

  const tenantId = opts.tenantId ?? children[0]?.tenantId ?? 'default';

  const summaryEntry = createMemory(content, {
    layer: Layer.Semantic,
    tags: [...sharedEntityTags, 'dag-summary'],
    confidence: 'inferred',
    dag_level: 2,
    tenantId,
    valid_from: stamp,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
  });
  // DETERMINISM: overwrite the wall-clock fields createMemory stamped.
  summaryEntry.created = stamp;
  summaryEntry.last_retrieved = stamp;
  // Schema v25: cache descendant_count + earliest/latest_at on the summary row.
  summaryEntry.descendant_count = children.length;
  summaryEntry.earliest_at = childCreatedAts[0] ?? null;
  summaryEntry.latest_at = childCreatedAts[childCreatedAts.length - 1] ?? null;
  writeEntry(hippoRoot, summaryEntry);

  for (const child of children) {
    const updated: MemoryEntry = { ...child, dag_parent_id: summaryEntry.id };
    writeEntry(hippoRoot, updated);
  }

  // E3 born-dirty cancellation: the child writeEntry calls fire the E2 dirty
  // hook on the summary; the summary we just built IS fresh, so clear it now.
  clearSummaryDirtyAfterBuild(hippoRoot, summaryEntry.id, summaryEntry.tenantId, 'createDagSummaryNode');

  return summaryEntry;
}

export async function buildDag(
  hippoRoot: string,
  facts: MemoryEntry[],
  opts: DagSummaryOptions,
): Promise<DagBuildResult> {
  const result: DagBuildResult = { candidateClusters: 0, summariesCreated: 0, factsLinked: 0 };

  const unparented = facts.filter(
    (f) => f.dag_level === 1 && !f.dag_parent_id && f.tags.includes('extracted'),
  );

  const clusters = clusterFacts(unparented);
  const eligibleClusters = clusters.filter((c) => c.members.length >= 3);
  result.candidateClusters = eligibleClusters.length;

  for (const cluster of eligibleClusters) {
    const summary = await generateDagSummary(
      cluster.label,
      cluster.members.map((m) => m.content),
      opts,
    );
    if (!summary) continue;

    // v0.30 — node creation (write summary + link children + cache scope
    // columns + born-dirty clear) is the shared createDagSummaryNode helper.
    // buildDag still owns the LLM text gen (generateDagSummary above); the
    // helper stamps deterministic timestamps from the children. buildDag's
    // children are dag_level=1 facts (the helper preserves their level via the
    // {...child} spread); only dag_parent_id changes.
    createDagSummaryNode(hippoRoot, {
      content: summary,
      children: cluster.members,
    });
    result.summariesCreated++;
    result.factsLinked += cluster.members.length;
  }

  return result;
}

// ---------------------------------------------------------------------------
// v0.30 / E3 of DAG live-coupling — rebuildDirtySummaries orchestrator
// ---------------------------------------------------------------------------

export interface DagRebuildResult {
  attempted: number;            // summaries we tried (<= cap)
  rebuilt: number;              // successful regenerations
  zeroChildSkipped: number;     // dirty-cleared without LLM (descendants all gone)
  failed: number;               // LLM null, fetch error, or applyRebuildResult throw
  capped: boolean;              // true if queue had more than cap entries
  detachedChildIds: string[];   // superseded children detached (dag_parent_id->null); caller drops from pendingWrites (codex P2)
}

/**
 * v0.30 / E3 — sleep-cycle phase that drains the dirty L2 summary queue.
 * Thin orchestrator; the heavy lifting lives in store.ts (load + apply)
 * and dag.ts:generateDagSummary (LLM call).
 *
 * Per-summary try/catch isolation (plan-eng-r1 MED must-fix) — one
 * throwing rebuild does NOT abort the rest of the queue.
 *
 * Race-loser handling: applyRebuildResult's UPDATE WHERE includes
 * AND summary_dirty=1, so concurrent sleep's second writer returns
 * changed=false. Silent skip (neither rebuilt++ nor failed++).
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
    zeroChildSkipped: 0,
    failed: 0,
    capped,
    detachedChildIds: [],
  };

  // DAG slice 1 — provenance dispatch: a merge-built summary (source=
  // 'consolidation') OR any rebuild with no LLM config (no apiKey) rebuilds via
  // the zero-dep extractive compressor; a buildDag-built summary rebuilds via
  // the LLM. Detect once outside the loop (apiKey is run-wide).
  const noLlmConfig = !opts.apiKey;

  for (const summary of queue) {
    try {
      const allChildren = loadChildrenOfSummary(hippoRoot, summary.id, summary.tenantId);
      // TOMBSTONE: exclude superseded children from the rebuild input so a
      // rebuilt summary DROPS the stale (superseded) child's content. The
      // successor (the new memory) is itself a live child if it was linked to
      // the same parent (supersede + writeEntryDbOnly hook), so the current
      // answer is retained while the stale one is dropped.
      const supersededChildren = allChildren.filter((c) => c.superseded_by);
      const children = allChildren.filter((c) => !c.superseded_by);

      // TOMBSTONE read-time guard: DETACH each superseded child from the parent
      // (dag_parent_id -> null) so it is also excluded from loadChildrenOf /
      // drillDown — a stale answer must never resurface as a live child. The
      // new parent is null, so the E2 write hook fires no dirty mark (no loop).
      // Kept in dag.ts (the rebuild owner) to avoid touching the read path.
      for (const stale of supersededChildren) {
        writeEntry(hippoRoot, { ...stale, dag_parent_id: null });
        result.detachedChildIds.push(stale.id);
      }

      if (children.length === 0) {
        // Zero-child case: clear dirty + zero counts, no rebuild, no count bump.
        const changed = applyRebuildResult(hippoRoot, summary, {
          content: summary.content,
          descendant_count: 0,
          earliest_at: null,
          latest_at: null,
          bumpRebuildCount: false,
          zeroChildren: true,
          actor: 'sleep',
        });
        if (changed) result.zeroChildSkipped++;
        // changed=false → race lost / row vanished; silently skip
        continue;
      }

      const useCompressor = summary.source === 'consolidation' || noLlmConfig;

      let newContent: string | null;
      if (useCompressor) {
        // Zero-dep, deterministic. Never null (pure function of child content).
        newContent = compressContents(children.map((c) => c.content));
      } else {
        // Derive label from summary's existing entity tags (mirrors clusterFacts)
        const entityTags = summary.tags.filter(
          (t) => t.startsWith('speaker:') || t.startsWith('topic:'),
        );
        const label = entityTags.length > 0
          ? entityTags.map((t) => t.split(':')[1]).join(': ')
          : summary.content.slice(0, 40);

        newContent = await generateDagSummary(
          label,
          children.map((c) => c.content),
          opts,
        );
      }

      if (!newContent) {
        // LLM null / fetch error → leave dirty for next cycle. (The compressor
        // never returns null, so this only fires on the LLM route.)
        result.failed++;
        continue;
      }

      const childCreatedAts = children.map((c) => c.created).sort();
      const changed = applyRebuildResult(hippoRoot, summary, {
        content: newContent,
        descendant_count: children.length,
        earliest_at: childCreatedAts[0],
        latest_at: childCreatedAts[childCreatedAts.length - 1],
        bumpRebuildCount: true,
        zeroChildren: false,
        actor: 'sleep',
      });
      if (changed) result.rebuilt++;
      // changed=false → race lost; not failure, not success, silently skip
    } catch (err) {
      // Per-summary failure isolation — one throw doesn't abort the queue.
      // independent-review MED #2 fold: log enough to triage in production
      // (audit() wraps its own writes try/catch per store.ts:2566, so a
      // throw here is exotic: SQLite I/O error, prepare failure, etc).
      result.failed++;
      // eslint-disable-next-line no-console
      console.error(
        `[rebuildDirtySummaries] summary ${summary.id} (tenant ${summary.tenantId}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// v0.30 / E5 of DAG live-coupling — L3 entity profile build path
// ---------------------------------------------------------------------------

export interface EntityProfilesBuildResult {
  candidateClusters: number;
  profilesCreated: number;
  l2sLinked: number;
  // independent-review MED #3 fold: surface failure counter so operators
  // see LLM null / rate-limit / 401 signal (parity with DagRebuildResult.failed).
  failed: number;
}

/**
 * v0.30 / E5 — build L3 entity profiles by clustering L2 summaries with
 * shared entity tags. Threshold 2+ L2s per entity. Mirrors buildDag L1->L2
 * pattern, one level up.
 *
 * Born-dirty cancellation (E3 lesson): after linking L2 children to the new
 * L3 (each link write fires E2 hook on L3 via widened markSummaryDirtyInTx),
 * call clearSummaryDirtyAfterBuild with source='buildEntityProfiles-clean'
 * so E3 sleep-cycle rebuild doesn't re-rebuild the freshly-built L3 this
 * same cycle.
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
  };

  // Only L2 with no L3 parent yet (avoid re-clustering already-profiled L2s).
  const unparented = l2Summaries.filter(
    (s) => s.dag_level === 2 && !s.dag_parent_id,
  );

  // independent-review HIGH #1 fold: cluster ONLY within-tenant.
  // clusterFacts has no tenant awareness; without this partition step a
  // multi-tenant host could form a cluster spanning tenants and produce
  // a single L3 with tenantId='default' that doesn't belong to either
  // child tenant. Fix: bucket by tenantId, run clusterFacts per-tenant,
  // pass tenantId to createMemory.
  const byTenant = new Map<string, MemoryEntry[]>();
  for (const l2 of unparented) {
    const tid = l2.tenantId ?? 'default';
    const list = byTenant.get(tid) ?? [];
    list.push(l2);
    byTenant.set(tid, list);
  }

  for (const [tenantId, tenantL2s] of byTenant) {
    const clusters = clusterFacts(tenantL2s);
    const eligible = clusters.filter((c) => c.members.length >= 2);
    result.candidateClusters += eligible.length;

    for (const cluster of eligible) {
      const summary = await generateDagSummary(
        cluster.label,
        cluster.members.map((m) => m.content),
        opts,
      );
      if (!summary) {
        result.failed++;
        continue;
      }

      const memberCreatedAts = cluster.members.map((m) => m.created).sort();
      const nowIso = new Date().toISOString();
      const profileEntry = createMemory(summary, {
        layer: Layer.Semantic,
        tags: [...cluster.entityTags, 'dag-entity-profile'],
        confidence: 'inferred',
        dag_level: 3,
        tenantId, // HIGH #1 fold: thread tenant explicitly
      });
      profileEntry.descendant_count = cluster.members.length;
      profileEntry.earliest_at = memberCreatedAts[0];
      profileEntry.latest_at = memberCreatedAts[memberCreatedAts.length - 1];
      profileEntry.dag_level_3_built_at = nowIso;
      writeEntry(hippoRoot, profileEntry);
      result.profilesCreated++;

      for (const member of cluster.members) {
        const updated: MemoryEntry = { ...member, dag_parent_id: profileEntry.id };
        writeEntry(hippoRoot, updated);
        result.l2sLinked++;
      }
      // E3 born-dirty cancellation, same dance as buildDag L161-168 but for
      // L3. Pass source='buildEntityProfiles-clean' to distinguish in audit.
      // Args: (root, id, tenantId, actor, source).
      clearSummaryDirtyAfterBuild(
        hippoRoot,
        profileEntry.id,
        tenantId,
        'buildEntityProfiles',
        'buildEntityProfiles-clean',
      );
    }
  }

  return result;
}
