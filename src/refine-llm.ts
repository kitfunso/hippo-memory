/**
 * LLM-powered refinement of consolidated semantic memories.
 *
 * The rule-based `mergeContents` in consolidate.ts produces functional but
 * ugly semantic memories — typically "[Consolidated from N related memories]"
 * prepended to the longest source, or a bulleted list. `hippo refine` takes
 * those and asks Claude to synthesize a clean, generalized principle.
 *
 * Design choices:
 * - Separate command (not baked into `hippo sleep`) so API-key users opt in.
 * - Idempotent via the `llm-refined` tag — re-running skips already-refined.
 * - Uses fetch directly so no SDK dependency.
 * - On failure (API error, bad response), the original memory is untouched.
 */

import { MemoryEntry, Layer } from './memory.js';
import { loadAllEntries, readEntry, writeEntry } from './store.js';

const REFINED_TAG = 'llm-refined';
const CONSOLIDATED_MARKERS = [
  '[Consolidated from',
  '[Consolidated pattern from',
];

export interface RefineOptions {
  apiKey: string;
  model?: string;
  limit?: number;
  dryRun?: boolean;
  /** Ignore the llm-refined tag and re-refine everything eligible. */
  all?: boolean;
  /** Injected for testing — defaults to the real fetch. */
  fetcher?: typeof fetch;
}

export interface RefineResult {
  scanned: number;
  refined: number;
  skipped: number;
  failed: number;
  details: Array<{ id: string; status: 'refined' | 'skipped' | 'failed'; reason?: string }>;
}

/**
 * Ask Claude to synthesize a clean semantic memory from the merged content
 * plus the original source memories. Returns the refined content string or
 * `null` when the API call failed.
 */
export async function refineSemanticMemory(
  merged: string,
  sources: MemoryEntry[],
  opts: { apiKey: string; model?: string; fetcher?: typeof fetch },
): Promise<string | null> {
  const model = opts.model ?? 'claude-sonnet-4-6';
  const fetchFn = opts.fetcher ?? fetch;

  const sourceBlock = sources
    .slice(0, 8)
    .map((s, i) => `[source ${i + 1}] ${s.content.slice(0, 400)}`)
    .join('\n\n');

  const prompt = `You are refining a semantic memory in an agent's memory store. The rule-based consolidator merged several related episodic memories into one, but the output is clumsy. Produce a single coherent semantic memory that captures the underlying principle.

Rules:
- Output ONLY the refined content — no preamble, no quote marks, no "Here is...".
- Keep it concise: one paragraph, no headers, no bullet lists unless the sources are inherently a list.
- Preserve specific facts (names, numbers, paths, IDs) from the sources.
- Generalize: state the pattern, not each instance.
- Do NOT include the "[Consolidated from N ...]" marker.

Current merged content:
${merged}

Source memories (up to 8 shown):
${sourceBlock}`;

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
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  try {
    const data = await res.json() as { content?: Array<{ text?: string }> };
    const text = data.content?.[0]?.text?.trim() ?? '';
    if (text.length < 10) return null;
    return text;
  } catch {
    return null;
  }
}

function isConsolidated(entry: MemoryEntry): boolean {
  if (entry.layer !== Layer.Semantic) return false;
  return CONSOLIDATED_MARKERS.some((m) => entry.content.startsWith(m));
}

/**
 * Scan the store for consolidated semantic memories, refine each with the
 * LLM, and write the refined content back. Tags with `llm-refined` so
 * repeated runs are idempotent (unless `all` is set).
 */
export async function refineStore(
  hippoRoot: string,
  opts: RefineOptions,
): Promise<RefineResult> {
  const result: RefineResult = {
    scanned: 0,
    refined: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  const entries = loadAllEntries(hippoRoot);
  let processed = 0;

  for (const entry of entries) {
    if (!isConsolidated(entry)) continue;
    result.scanned++;

    if (!opts.all && entry.tags.includes(REFINED_TAG)) {
      result.skipped++;
      result.details.push({ id: entry.id, status: 'skipped', reason: 'already refined' });
      continue;
    }

    if (opts.limit !== undefined && processed >= opts.limit) break;
    processed++;

    // Best-effort: walk parents_json (schema v9) to fetch originals. When
    // parents aren't recorded we still refine using just the merged content.
    const sources: MemoryEntry[] = [];
    const parentIds = Array.isArray(entry.parents) ? entry.parents : [];
    for (const pid of parentIds) {
      const p = readEntry(hippoRoot, pid);
      if (p) sources.push(p);
    }

    const refined = await refineSemanticMemory(entry.content, sources, {
      apiKey: opts.apiKey,
      model: opts.model,
      fetcher: opts.fetcher,
    });

    if (refined === null) {
      result.failed++;
      result.details.push({ id: entry.id, status: 'failed', reason: 'api error or empty response' });
      continue;
    }

    if (opts.dryRun) {
      result.refined++;
      result.details.push({ id: entry.id, status: 'refined', reason: 'dry-run (no write)' });
      continue;
    }

    const updated: MemoryEntry = {
      ...entry,
      content: refined,
      tags: entry.tags.includes(REFINED_TAG) ? entry.tags : [...entry.tags, REFINED_TAG],
    };
    writeEntry(hippoRoot, updated);
    result.refined++;
    result.details.push({ id: entry.id, status: 'refined' });
  }

  return result;
}
