import { MemoryEntry, Layer, EmotionalValence, createMemory } from '../core/memory.js';
import { writeEntry } from '../store/entry-writes.js';
import { loadConfig } from '../core/config.js';
import { RejectedValueError } from '../store/rejection.js';
import { redactSecretsStrict } from '../util/secret-detect.js';
import { describeMessageFailure, sendAnthropicMessage } from '../util/anthropic-messages.js';
import { neverAutoShareTags } from '../sharing/shared.js';
import { errorMessage, log } from '../util/log.js';
import { isJsonString, type JsonValue } from '../util/json.js';
import { certainDefect } from '../core/memory-quality.js';

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

// Output budget for one extraction reply.
const EXTRACTION_MAX_TOKENS = 1200;

export async function extractFacts(
  text: string,
  opts: ExtractOptions,
): Promise<ExtractedFact[]> {
  const reply = await sendAnthropicMessage({
    apiKey: opts.apiKey,
    model: opts.model,
    maxTokens: EXTRACTION_MAX_TOKENS,
    prompt: EXTRACTION_PROMPT + redactSecretsStrict(text),
    fetcher: opts.fetcher,
  });
  if (!reply.ok) {
    opts.onError?.(describeMessageFailure(reply.failure));
    return [];
  }

  try {
    const raw = reply.text;
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parseExtractedFacts(parsed);
  } catch (err) {
    opts.onError?.(`unparseable response: ${errorMessage(err)}`);
    return [];
  }
}

// One element of the model's JSON array, before the per-field checks below.
interface RawExtractedFact {
  content?: JsonValue;
  tags?: JsonValue;
  valence?: JsonValue;
}

function parseExtractedFacts(parsed: (RawExtractedFact | null)[]): ExtractedFact[] {
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
    // SAFETY: the isJsonString + validValences.has guard below confirms item.valence is one of the four literal strings of EmotionalValence.
    const valence: EmotionalValence = isJsonString(item.valence) && validValences.has(item.valence)
      ? (item.valence as EmotionalValence)
      : 'neutral';

    facts.push({ content: item.content, tags, valence });
  }

  return facts;
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
    const entry = buildExtractedEntry(fact, source, inheritedTags, baseHalfLifeDays);

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

function buildExtractedEntry(
  fact: ExtractedFact,
  source: MemoryEntry,
  inheritedTags: string[],
  baseHalfLifeDays: number,
): MemoryEntry {
  const tags = ['extracted', ...inheritedTags, ...fact.tags];
  return { ...createMemory(fact.content, {
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
}
