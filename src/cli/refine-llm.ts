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

import { MemoryEntry, Layer } from '../core/memory.js';
import { writeEntry } from '../store/entry-writes.js';
import { loadAllEntries, readEntry } from '../store/entry-reads.js';
import { redactSecretsStrict } from '../util/secret-detect.js';
import { sendAnthropicMessage, type AnthropicMessageFailure } from '../util/anthropic-messages.js';
import { log } from '../util/log.js';

const MAX_REFINE_SOURCES = 8;
const REFINE_SOURCE_CHARS = 400;

const REFINED_TAG = 'llm-refined';
// Output budget for one refined memory, and the shortest reply kept as a refinement.
const REFINE_MAX_TOKENS = 800;
const REFINE_MIN_CHARS = 10;
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
  /**
   * Tenant scope. When provided, refineStore only scans consolidated
   * entries belonging to this tenant, and parent lookups are scoped to the
   * same tenant. Cross-tenant parents return null from readEntry and are
   * silently skipped (refine still produces output from merged content).
   * Undefined preserves pre-1.12.1 host-wide scan behaviour.
   */
  tenantId?: string;
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
  const sourceBlock = sources
    .slice(0, MAX_REFINE_SOURCES)
    .map((s, i) => `[source ${i + 1}] ${redactSecretsStrict(s.content).slice(0, REFINE_SOURCE_CHARS)}`)
    .join('\n\n');

  const prompt = `You are refining a semantic memory in an agent's memory store. The rule-based consolidator merged several related episodic memories into one, but the output is clumsy. Produce a single coherent semantic memory that captures the underlying principle.

Rules:
- Output ONLY the refined content — no preamble, no quote marks, no "Here is...".
- Keep it concise: one paragraph, no headers, no bullet lists unless the sources are inherently a list.
- Preserve specific facts (names, numbers, paths, IDs) from the sources.
- Generalize: state the pattern, not each instance.
- Do NOT include the "[Consolidated from N ...]" marker.

Current merged content:
${redactSecretsStrict(merged)}

Source memories (up to 8 shown):
${sourceBlock}`;

  const reply = await sendAnthropicMessage({
    apiKey: opts.apiKey,
    model: opts.model,
    maxTokens: REFINE_MAX_TOKENS,
    prompt,
    fetcher: opts.fetcher,
  });
  if (!reply.ok) {
    log.warn(describeRefineFailure(reply.failure));
    return null;
  }
  if (reply.text.length < REFINE_MIN_CHARS) {
    log.warn('refine: response was empty or too short to use');
    return null;
  }
  return reply.text;
}

function describeRefineFailure(failure: AnthropicMessageFailure): string {
  switch (failure.kind) {
    case 'request': return `refine: request failed: ${failure.message}`;
    case 'http': return `refine: API answered HTTP ${failure.status}`;
    case 'unreadable': return `refine: unreadable response: ${failure.message}`;
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

  // When opts.tenantId is provided, scope the top-level scan to this
  // tenant's consolidated entries.
  const entries = loadAllEntries(hippoRoot, opts.tenantId);
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

    await refineOneEntry(hippoRoot, entry, opts, result);
  }

  return result;
}

async function refineOneEntry(
  hippoRoot: string,
  entry: MemoryEntry,
  opts: RefineOptions,
  result: RefineResult,
): Promise<void> {
  // Best-effort: walk parents_json (schema v9) to fetch originals. When
  // parents aren't recorded we still refine using just the merged content.
  const sources: MemoryEntry[] = [];
  const parentIds = Array.isArray(entry.parents) ? entry.parents : [];
  for (const pid of parentIds) {
    // Parent lookup scoped by opts.tenantId when provided.
    // Cross-tenant parents return null and are silently skipped — refine
    // still produces output from the merged content alone (graceful
    // degradation rather than refuse-to-refine).
    const p = readEntry(hippoRoot, pid, opts.tenantId);
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
    return;
  }

  if (opts.dryRun) {
    result.refined++;
    result.details.push({ id: entry.id, status: 'refined', reason: 'dry-run (no write)' });
    return;
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
