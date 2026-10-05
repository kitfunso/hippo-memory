import { MemoryEntry, Layer, EmotionalValence, createMemory } from './memory.js';
import { writeEntry } from './store/entry-writes.js';
import { loadConfig } from './config.js';
import { RejectedValueError } from './rejection.js';
import { redactSecretsStrict } from './secret-detect.js';
import { fetchWithRetry, llmTimeoutMs } from './http-retry.js';
import { neverAutoShareTags } from './shared.js';
import { log } from './log.js';
import { isJsonString } from './json.js';
import { certainDefect } from './automatic-memory-quality.js';

export interface ExtractedFact {
  content: string;
  tags: string[];
  valence: EmotionalValence;
}

export interface ExtractOptions {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
  /** Told why a call produced nothing, so callers can surface it instead of guessing. */
  onError?: (msg: string) => void;
}

const EXTRACTION_PROMPT = `You are extracting factual statements from a conversation or memory entry. Extract 1-8 standalone factual statements that would be useful to remember later.

Rules:
- Each fact must be a complete, standalone sentence
- Include the speaker's name in every fact (e.g. "Alice prefers..." not "She prefers...")
- Preserve specific details: names, numbers, dates, paths, IDs
- Return a JSON array of objects with: content (string), tags (array of "speaker:X" and "topic:Y" strings), valence ("neutral", "positive", "negative", or "critical")
- Return an empty array [] for small talk with no extractable facts
- Output ONLY the JSON array, no preamble or explanation

Input text:
`;

export async function extractFacts(
  text: string,
  opts: ExtractOptions,
): Promise<ExtractedFact[]> {
  const model = opts.model ?? 'claude-sonnet-4-6';
  const fetchFn = opts.fetcher ?? fetch;

  let res: Response;
  try {
    res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        messages: [{ role: 'user', content: EXTRACTION_PROMPT + redactSecretsStrict(text) }],
      }),
    }, { timeoutMs: llmTimeoutMs(), fetchFn });
  } catch (err) {
    opts.onError?.(`request failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  if (!res.ok) {
    opts.onError?.(`HTTP ${res.status}`);
    return [];
  }

  try {
    const data: { content?: Array<{ text?: string }> } = await res.json();
    const raw = data.content?.[0]?.text?.trim() ?? '';
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const validValences = new Set<string>(['neutral', 'positive', 'negative', 'critical']);
    const facts: ExtractedFact[] = [];

    for (const item of parsed) {
      if (facts.length >= 8) break;
      if (
        !item ||
        !isJsonString(item.content) ||
        item.content.length < 3
      )
        continue;

      const itemTags = item.tags;
      const tags = Array.isArray(itemTags)
        ? itemTags.filter((t) => isJsonString(t))
        : [];
      // SAFETY: validValences.has(item.valence) above confirms item.valence is one of the four literal strings of EmotionalValence.
      const valence: EmotionalValence = validValences.has(item.valence)
        ? (item.valence as EmotionalValence)
        : 'neutral';

      facts.push({ content: item.content, tags, valence });
    }

    return facts;
  } catch (err) {
    opts.onError?.(`unparseable response: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

const INHERITABLE_PREFIXES = ['conv:', 'session:', 'scope:', 'path:'];

export function storeExtractedFacts(
  hippoRoot: string,
  source: MemoryEntry,
  facts: ExtractedFact[],
): MemoryEntry[] {
  const inheritedTags = [
    ...source.tags.filter((t) => INHERITABLE_PREFIXES.some((p) => t.startsWith(p))),
    ...neverAutoShareTags([source]),
  ];

  const entries: MemoryEntry[] = [];
  let rejected = 0;
  const baseHalfLifeDays = loadConfig(hippoRoot).defaultHalfLifeDays;

  for (const fact of facts) {
    const defect = certainDefect(fact.content);
    if (defect !== null) {
      log.warn(`storeExtractedFacts: skipped automatic quality defect (${defect})`);
      continue;
    }
    const tags = ['extracted', ...inheritedTags, ...fact.tags];
    const entry: MemoryEntry = { ...createMemory(fact.content, {
      layer: Layer.Semantic,
      tags,
      emotional_valence: fact.valence,
      confidence: 'inferred',
      source: source.source,
      extracted_from: source.id,
      scope: source.scope,
      // Without it createMemory stamps 'default', and extracted facts leave
      // the tenant of the episodic memory they were extracted from.
      tenantId: source.tenantId,
      baseHalfLifeDays,
    }), origin_project: source.origin_project };

    // A refusal is per-VALUE: one rejected fact must not
    // drop the rest of this batch. writeEntry has already audited the
    // refusal (reject_refusal) before rethrowing, so skip-and-count here.
    try {
      writeEntry(hippoRoot, entry);
    } catch (err) {
      if (err instanceof RejectedValueError) {
        rejected++;
        continue;
      }
      throw err;
    }
    entries.push(entry);
  }

  if (rejected > 0) {
    log.warn(`storeExtractedFacts: skipped ${rejected} rejected value(s)`);
  }

  return entries;
}
