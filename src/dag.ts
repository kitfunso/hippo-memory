import { createMemory, Layer, type MemoryEntry } from './memory.js';
import {
  writeEntry,
  loadAllDirtySummaries,
  loadChildrenOfSummary,
  applyRebuildResult,
  clearSummaryDirtyAfterBuild,
} from './store.js';
import { RejectedValueError } from './rejection.js';

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
  /** AT1: clusters skipped because the LLM-synthesized summary landed on a
   *  rejected value (plan §3 containment — per-cluster catch, not a whole-
   *  phase abort). Member re-parenting writes are unaffected by construction
   *  (same id + same content = guard-exempt), so this only ever counts
   *  summary-creation refusals. */
  rejected: number;
}

export async function buildDag(
  hippoRoot: string,
  facts: MemoryEntry[],
  opts: DagSummaryOptions,
): Promise<DagBuildResult> {
  const result: DagBuildResult = { candidateClusters: 0, summariesCreated: 0, factsLinked: 0, rejected: 0 };

  const unparented = facts.filter(
    (f) => f.dag_level === 1 && !f.dag_parent_id && f.tags.includes('extracted'),
  );

  // Hardening follow-up (mirrors consolidate.ts's mergeCandidatesByTenant,
  // T1): partition unparented facts by tenantId BEFORE clustering so a
  // cluster can never mix facts from different tenants into one
  // LLM-synthesized summary. Map preserves insertion order, so
  // single-tenant stores (every row 'default') get exactly one partition
  // and iterate in the same order as before this fix — byte-identical
  // behavior there.
  const unparentedByTenant = new Map<string, MemoryEntry[]>();
  for (const fact of unparented) {
    const bucket = unparentedByTenant.get(fact.tenantId);
    if (bucket) bucket.push(fact);
    else unparentedByTenant.set(fact.tenantId, [fact]);
  }

  for (const [factTenant, tenantFacts] of unparentedByTenant) {
    const clusters = clusterFacts(tenantFacts);
    const eligibleClusters = clusters.filter((c) => c.members.length >= 3);
    result.candidateClusters += eligibleClusters.length;

    for (const cluster of eligibleClusters) {
      const summary = await generateDagSummary(
        cluster.label,
        cluster.members.map((m) => m.content),
        opts,
      );
      if (!summary) continue;

      const memberCreatedAts = cluster.members.map((m) => m.created).sort();
      // Every member of `cluster` shares factTenant by construction (the
      // tenant partition above), so the summary lands in the same tenant
      // as the facts it summarizes instead of always 'default'
      // (memory.ts:535 defaults tenantId when the option is omitted).
      const summaryEntry = createMemory(summary, {
        layer: Layer.Semantic,
        tags: [...cluster.entityTags, 'dag-summary'],
        confidence: 'inferred',
        dag_level: 2,
        tenantId: factTenant,
      });
      // Schema v25: cache descendant_count + earliest/latest_at on the summary
      // row so DAG-aware recall (docs/plans/2026-05-05-dag-recall.md Task 2)
      // can reason about scope without walking the children.
      summaryEntry.descendant_count = cluster.members.length;
      summaryEntry.earliest_at = memberCreatedAts[0];
      summaryEntry.latest_at = memberCreatedAts[memberCreatedAts.length - 1];
      // AT1 (plan §3 containment): a refused LLM-synthesized summary skips
      // ONLY this cluster — the sleep cycle continues to the next one. The
      // member re-parenting writes below never run for a skipped cluster
      // (there is no summary id to parent them under).
      //
      // The tombstone check itself is tenant-scoped for free: writeEntry ->
      // writeEntryDbOnly -> upsertEntryRow calls
      // checkRejectionGuard(db, entry.tenantId ?? 'default', ...)
      // (store.ts:1172), reading tenantId off the entry being written. Now
      // that summaryEntry carries factTenant instead of the implicit
      // 'default', the guard consults that tenant's tombstones — no
      // separate check needed here (unlike consolidate.ts's merge pass,
      // which pre-checks via findRejectedValue because it writes through
      // batchWriteAndDelete's bypassRejectionGuard path instead of
      // writeEntry).
      try {
        writeEntry(hippoRoot, summaryEntry);
      } catch (err) {
        if (err instanceof RejectedValueError) {
          result.rejected++;
          console.error(`[buildDag] cluster "${cluster.label}" skipped: summary matches a rejected value`);
          continue;
        }
        throw err;
      }
      result.summariesCreated++;

      for (const member of cluster.members) {
        const updated: MemoryEntry = { ...member, dag_parent_id: summaryEntry.id };
        writeEntry(hippoRoot, updated);
        result.factsLinked++;
      }
      // v0.30 / E3 — cancel the cascade of dirty-marks fired by member
      // writeEntry calls (E2 hook on writeEntryDbOnly at store.ts:1214).
      // The summary we just built IS fresh, no rebuild needed. Without this,
      // E3 in the SAME sleep cycle would re-rebuild every new summary
      // (2x LLM cost). plan-eng-r1 HIGH must-fix.
      clearSummaryDirtyAfterBuild(hippoRoot, summaryEntry.id, summaryEntry.tenantId, 'buildDag');
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// v0.30 / E3 of DAG live-coupling — rebuildDirtySummaries orchestrator
// ---------------------------------------------------------------------------

export interface DagRebuildResult {
  attempted: number;            // summaries we tried (<= cap)
  rebuilt: number;              // successful regenerations
  refused: number;              // tombstone-hit refusals — dirty cleared, content NOT written (T4 split from `rebuilt`)
  zeroChildSkipped: number;     // dirty-cleared without LLM (descendants all gone)
  failed: number;               // LLM null, fetch error, or applyRebuildResult throw
  capped: boolean;              // true if queue had more than cap entries
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
 * changed=false. Silent skip (neither rebuilt++ nor refused++ nor failed++).
 *
 * T4: applyRebuildResult returns { changed, refused } — a tombstone hit
 * (rebuild content matches a previously-rejected value) increments
 * `refused`, not `rebuilt`. Dirty still clears either way; only the stat
 * split changed (docs/plans/2026-08-15-hardening-at1-followups.md T4).
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
      const children = loadChildrenOfSummary(hippoRoot, summary.id, summary.tenantId);

      if (children.length === 0) {
        // Zero-child case: clear dirty + zero counts, no LLM call, no rebuild_count bump.
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
        // tombstone when bumpRebuildCount is true (store.ts:3398).
        continue;
      }

      // Derive label from summary's existing entity tags (mirrors clusterFacts)
      const entityTags = summary.tags.filter(
        (t) => t.startsWith('speaker:') || t.startsWith('topic:'),
      );
      const label = entityTags.length > 0
        ? entityTags.map((t) => t.split(':')[1]).join(': ')
        : summary.content.slice(0, 40);

      const newContent = await generateDagSummary(
        label,
        children.map((c) => c.content),
        opts,
      );

      if (!newContent) {
        // LLM null / fetch error → leave dirty for next cycle
        result.failed++;
        continue;
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
  /** AT1: clusters skipped because the profile summary landed on a rejected
   *  value (plan §3 containment). Kept distinct from `failed` (LLM null /
   *  rate-limit) — a tombstone hit is a deliberate refusal, not an error. */
  rejected: number;
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
    rejected: 0,
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
      // AT1 (plan §3 containment): per-cluster catch — skip this cluster,
      // count, log once. The member re-linking writes below never run for a
      // skipped cluster (mirrors buildDag above).
      try {
        writeEntry(hippoRoot, profileEntry);
      } catch (err) {
        if (err instanceof RejectedValueError) {
          result.rejected++;
          console.error(`[buildEntityProfiles] cluster "${cluster.label}" skipped: profile matches a rejected value`);
          continue;
        }
        throw err;
      }
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
