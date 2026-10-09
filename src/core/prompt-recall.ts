/** Recall gated on the hook prompt, not the five newest memories (pure, no I/O). */
import { tokenize } from '../util/tokenize.js';
import { STOP_WORDS } from './memory-quality.js';

export type PromptRecallMetric = 'jaccard' | 'cosine';

export interface PromptRecallGate {
  metric: PromptRecallMetric;
  threshold: number;
  minShared: number;
  maxItems: number;
}

// Latency bound, not tuned: fixed in the prereg regardless of gate config.
export const PROMPT_RECALL_MAX_CHARS = 4000;

/** Distinct content tokens: longer than 2 chars, not a stop word. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    if (t.length > 2 && !STOP_WORDS.has(t)) out.add(t);
  }
  return out;
}

export function promptTokens(prompt: string): Set<string> {
  return contentTokens(prompt.slice(0, PROMPT_RECALL_MAX_CHARS));
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
  const score = metric === 'jaccard'
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
  kept.sort((a, b) => (b.score - a.score) || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  return kept.slice(0, gate.maxItems);
}

/** The prompt's content tokens as an FTS pre-select query, capped at `maxTerms`. */
export function promptRecallFtsQuery(p: ReadonlySet<string>, maxTerms = 32): string {
  const terms: string[] = [];
  for (const t of p) {
    if (terms.length >= maxTerms) break;
    terms.push(t);
  }
  return terms.join(' ');
}

// bm25 ranks every row matching any term, so fewer and rarer terms bound latency; 8 is a bound, not tuned.
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
    .sort((a, b) => (a.c - b.c) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .slice(0, maxTerms)
    .map((x) => x.t);
}

/** The pieces FTS5's unicode61 tokenizer indexes a term as, so `journal_mode` is `journal` and `mode`. */
export function ftsTermParts(term: string): string[] {
  return term.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The rarest terms as a space-joined FTS query, given each part's document count; a term counts as its rarest part,
 *  an upper bound on rows holding the whole term, and a term with no parts counts 0, so it is dropped. */
export function rarestFtsQuery(
  terms: readonly string[],
  docCount: (part: string) => number,
  maxTerms = RAREST_TERM_COUNT,
): string {
  const termCount = (t: string): number => {
    const parts = ftsTermParts(t);
    return parts.length === 0 ? 0 : Math.min(...parts.map(docCount));
  };
  return rarestPromptTerms(terms, termCount, maxTerms).join(' ');
}
