/** Recall gated on the hook prompt, not the five newest memories (pure, no I/O). */
import { cjkIndexTerms, indexTokenize, partitionCjkTerms, tokenizeMin } from '../util/tokenize.js';
import { MEMORY_QUALITY_STOPWORDS } from '../util/stopwords.js';

export type PromptRecallMetric = 'jaccard' | 'cosine';

export interface PromptRecallGate {
  metric: PromptRecallMetric;
  threshold: number;
  minShared: number;
  maxItems: number;
}

// Latency bound, not tuned: fixed in the prereg regardless of gate config.
const PROMPT_RECALL_MAX_CHARS = 4000;

/** Distinct content tokens: longer than 2 chars or CJK, not a stop word. */
export function contentTokens(text: string): Set<string> {
  return withoutStopwords(tokenizeMin(text, 3));
}

export function promptTokens(prompt: string): Set<string> {
  return contentTokens(prompt.slice(0, PROMPT_RECALL_MAX_CHARS));
}

/** `contentTokens` of a memory a prompt is matched against: each letter of a longer CJK run is
 * added, so a one-letter prompt word matches inside a run, as `hippo recall` matches it. */
export function memoryTokens(content: string): Set<string> {
  return withoutStopwords(indexTokenize(content, 3));
}

function withoutStopwords(tokens: readonly string[]): Set<string> {
  return new Set(tokens.filter((t) => !MEMORY_QUALITY_STOPWORDS.has(t)));
}

/** The terms a store searches for the prompt: its tokens, with each CJK run as its letter
 * trigrams, which the trigram index can look up across the store, in place of bigrams, which it
 * cannot. */
export function promptSearchTerms(prompt: string): string[] {
  const text = prompt.slice(0, PROMPT_RECALL_MAX_CHARS);
  return [...partitionCjkTerms(contentTokens(text)).words, ...cjkIndexTerms(text)];
}

export interface OverlapScore {
  score: number;
  shared: number;
}

/** Overlap of two token sets under `metric`. 0 when either set is empty. */
export function scoreOverlap(
  p: ReadonlySet<string>,
  m: ReadonlySet<string>,
  metric: PromptRecallMetric,
): OverlapScore {
  if (p.size === 0 || m.size === 0) return { score: 0, shared: 0 };
  const [small, large] = p.size <= m.size ? [p, m] : [m, p];
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  const score =
    metric === 'jaccard'
      ? shared / (p.size + m.size - shared)
      : shared / Math.sqrt(p.size * m.size);
  return { score, shared };
}

/** Candidates that clear the gate, sorted score desc then id asc, capped at `gate.maxItems`. */
export function gatePromptRecall<T extends { id: string; tokens: ReadonlySet<string> }>(
  p: ReadonlySet<string>,
  candidates: readonly T[],
  gate: PromptRecallGate,
): Array<{ item: T; score: number; shared: number }> {
  if (p.size === 0) return [];
  const kept: Array<{ item: T; score: number; shared: number }> = [];
  for (const item of candidates) {
    const { score, shared } = scoreOverlap(p, item.tokens, gate.metric);
    if (score >= gate.threshold && shared >= gate.minShared) kept.push({ item, score, shared });
  }
  kept.sort(
    (a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  return kept.slice(0, gate.maxItems);
}

// bm25 ranks every row matching any term, so fewer and rarer terms bound latency; 8 is a bound, not
// tuned.
export const RAREST_TERM_COUNT = 8;

/** Terms sorted by ascending FTS doc count (rarest first), zero-count terms dropped, ties by term.
 *  Pure: `docCount` (an FTS lookup in the caller) does the only I/O. */
export function rarestPromptTerms(
  terms: Iterable<string>,
  docCount: (term: string) => number,
  maxTerms = RAREST_TERM_COUNT,
): string[] {
  return Array.from(terms)
    .map((t) => ({ t, c: docCount(t) }))
    .filter((x) => x.c > 0)
    .sort((a, b) => a.c - b.c || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .slice(0, maxTerms)
    .map((x) => x.t);
}

/** The pieces FTS5's unicode61 tokenizer indexes a term as, so `journal_mode` is `journal` and
 * `mode`. */
export function ftsTermParts(term: string): string[] {
  return term.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The rarest terms as a space-joined FTS query, given each part's document count; a term counts as its rarest part, an
 *  upper bound on rows holding the whole term, and a term with no parts counts 0, so it is dropped. A CJK term counts
 *  by `cjkDocCount`, a trigram index's count, in the same pick; without one, CJK terms take `spreadCjkTerms` slots. */
export function rarestFtsQuery(
  terms: readonly string[],
  docCount: (part: string) => number,
  maxTerms = RAREST_TERM_COUNT,
  cjkDocCount?: (term: string) => number,
): string {
  const termCount = (t: string): number => {
    const parts = ftsTermParts(t);
    return parts.length === 0 ? 0 : Math.min(...parts.map(docCount));
  };
  const { words, cjk } = partitionCjkTerms(terms);
  if (cjkDocCount === undefined) {
    return spreadCjkTerms([...rarestPromptTerms(words, termCount, maxTerms), ...cjk], maxTerms).join(' ');
  }
  const counts = new Map([
    ...words.map((t) => [t, termCount(t)] as const),
    ...cjk.map((t) => [t, cjkDocCount(t)] as const),
  ]);
  return rarestPromptTerms(counts.keys(), (t) => counts.get(t) ?? 0, maxTerms).join(' ');
}

/** Up to `maxTerms` of `terms` when no index counts their CJK terms: those keep half the slots, at even
 *  steps through the prompt, so neither a long run of words nor the prompt's opening letters starve them. */
export function spreadCjkTerms(terms: readonly string[], maxTerms: number): string[] {
  // SHORTCUT: even steps, not rarest first; a store with a trigram index ranks CJK terms by its counts.
  const { words, cjk } = partitionCjkTerms(terms);
  const cjkSlots = Math.min(cjk.length, Math.max(Math.ceil(maxTerms / 2), maxTerms - words.length));
  const step = cjkSlots > 1 ? (cjk.length - 1) / (cjkSlots - 1) : 0;
  const kept = new Set(Array.from({ length: cjkSlots }, (_, i) => Math.round(i * step)));
  return [...words.slice(0, maxTerms - cjkSlots), ...cjk.filter((_, k) => kept.has(k))];
}
