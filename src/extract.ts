import { MemoryEntry, Layer, EmotionalValence, createMemory } from './memory.js';
import { writeEntry } from './store.js';

export interface ExtractedFact {
  content: string;
  tags: string[];
  valence: EmotionalValence;
}

export interface ExtractOptions {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
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
    res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        messages: [{ role: 'user', content: EXTRACTION_PROMPT + text }],
      }),
    });
  } catch {
    return [];
  }

  if (!res.ok) return [];

  try {
    const data = await res.json() as { content?: Array<{ text?: string }> };
    const raw = data.content?.[0]?.text?.trim() ?? '';
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const validValences = new Set<string>(['neutral', 'positive', 'negative', 'critical']);
    const facts: ExtractedFact[] = [];

    for (const item of parsed) {
      if (facts.length >= 8) break;
      if (!item || typeof item.content !== 'string' || item.content.length < 3) continue;

      const tags = Array.isArray(item.tags)
        ? item.tags.filter((t: unknown) => typeof t === 'string')
        : [];
      const valence: EmotionalValence = validValences.has(item.valence)
        ? (item.valence as EmotionalValence)
        : 'neutral';

      facts.push({ content: item.content, tags, valence });
    }

    return facts;
  } catch {
    return [];
  }
}

const INHERITABLE_PREFIXES = ['conv:', 'session:', 'scope:', 'path:'];

export function storeExtractedFacts(
  hippoRoot: string,
  source: MemoryEntry,
  facts: ExtractedFact[],
): MemoryEntry[] {
  const inheritedTags = source.tags.filter((t) =>
    INHERITABLE_PREFIXES.some((p) => t.startsWith(p)),
  );

  const entries: MemoryEntry[] = [];

  for (const fact of facts) {
    const tags = ['extracted', ...inheritedTags, ...fact.tags];
    const entry = createMemory(fact.content, {
      layer: Layer.Semantic,
      tags,
      emotional_valence: fact.valence,
      confidence: 'inferred',
      source: source.source,
      extracted_from: source.id,
    });

    writeEntry(hippoRoot, entry);
    entries.push(entry);
  }

  return entries;
}
