import { createMemory, Layer, type MemoryEntry } from './memory.js';
import {
  writeEntry,
  loadAllDirtySummaries,
  loadChildrenOfSummary,
  applyRebuildResult,
  clearSummaryDirtyAfterBuild,
} from './store.js';

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

    const memberCreatedAts = cluster.members.map((m) => m.created).sort();
    const summaryEntry = createMemory(summary, {
      layer: Layer.Semantic,
      tags: [...cluster.entityTags, 'dag-summary'],
      confidence: 'inferred',
      dag_level: 2,
    });
    // Schema v25: cache descendant_count + earliest/latest_at on the summary
    // row so DAG-aware recall (docs/plans/2026-05-05-dag-recall.md Task 2)
    // can reason about scope without walking the children.
    summaryEntry.descendant_count = cluster.members.length;
    summaryEntry.earliest_at = memberCreatedAts[0];
    summaryEntry.latest_at = memberCreatedAts[memberCreatedAts.length - 1];
    writeEntry(hippoRoot, summaryEntry);
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
  };

  for (const summary of queue) {
    try {
      const children = loadChildrenOfSummary(hippoRoot, summary.id, summary.tenantId);

      if (children.length === 0) {
        // Zero-child case: clear dirty + zero counts, no LLM call, no rebuild_count bump.
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
