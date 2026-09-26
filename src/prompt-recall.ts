/** Z1: recall gated on the hook prompt, not the five newest memories (pure, no I/O).
 *  See docs/plans/2026-09-26-z1-prompt-recall.md. */
import { tokenize } from './search.js';
import { STOP_WORDS } from './audit.js';

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
