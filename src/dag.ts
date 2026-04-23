import { createMemory, Layer, type MemoryEntry } from './memory.js';
import { writeEntry } from './store.js';

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

    const summaryEntry = createMemory(summary, {
      layer: Layer.Semantic,
      tags: [...cluster.entityTags, 'dag-summary'],
      confidence: 'inferred',
      dag_level: 2,
    });
    writeEntry(hippoRoot, summaryEntry);
    result.summariesCreated++;

    for (const member of cluster.members) {
      const updated: MemoryEntry = { ...member, dag_parent_id: summaryEntry.id };
      writeEntry(hippoRoot, updated);
      result.factsLinked++;
    }
  }

  return result;
}
