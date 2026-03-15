/**
 * BM25 search + strength-ranked retrieval for Hippo.
 * Zero external dependencies  - implemented from scratch.
 */

import { MemoryEntry, calculateStrength } from './memory.js';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// ---------------------------------------------------------------------------
// BM25 implementation
// ---------------------------------------------------------------------------

interface BM25Corpus {
  docs: string[][];        // tokenized documents
  avgLen: number;
  df: Map<string, number>; // document frequency per term
  N: number;               // total documents
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

function buildCorpus(texts: string[]): BM25Corpus {
  const docs = texts.map(tokenize);
  const N = docs.length;
  const df = new Map<string, number>();

  let totalLen = 0;
  for (const doc of docs) {
    totalLen += doc.length;
    const seen = new Set<string>();
    for (const term of doc) {
      if (!seen.has(term)) {
        df.set(term, (df.get(term) ?? 0) + 1);
        seen.add(term);
      }
    }
  }

  const avgLen = N > 0 ? totalLen / N : 1;
  return { docs, avgLen, df, N };
}

function bm25Score(corpus: BM25Corpus, docIdx: number, queryTerms: string[]): number {
  const doc = corpus.docs[docIdx];
  const docLen = doc.length;
  let score = 0;

  // Term frequency map for this doc
  const tf = new Map<string, number>();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);

  for (const term of queryTerms) {
    const f = tf.get(term) ?? 0;
    if (f === 0) continue;

    const df = corpus.df.get(term) ?? 0;
    const idf = Math.log((corpus.N - df + 0.5) / (df + 0.5) + 1);
    const numerator = f * (BM25_K1 + 1);
    const denominator = f + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / corpus.avgLen));
    score += idf * (numerator / denominator);
  }

  return score;
}

// ---------------------------------------------------------------------------
// Token budget estimation
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: characters / 4 (works well for English text).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Recency boost
// ---------------------------------------------------------------------------

function recencyBoost(entry: MemoryEntry, now: Date): number {
  const created = new Date(entry.created);
  const ageDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
  // Exponential decay: memories < 1 day get boost ~1.0, older get less
  return Math.exp(-ageDays / 30);
}

// ---------------------------------------------------------------------------
// Public search API
// ---------------------------------------------------------------------------

export interface SearchResult {
  entry: MemoryEntry;
  score: number;          // composite score
  bm25: number;
  tokens: number;
}

/**
 * Search entries using BM25 + strength + recency composite score.
 * Returns results sorted by score, capped at token budget.
 *
 * Also updates retrieval metadata on returned entries (side effect: caller
 * must persist the updated entries).
 */
export function search(
  query: string,
  entries: MemoryEntry[],
  options: { budget?: number; now?: Date } = {}
): SearchResult[] {
  const now = options.now ?? new Date();
  const budget = options.budget ?? 4000;

  if (entries.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  // Build corpus from all entries (content + tags joined)
  const texts = entries.map((e) => `${e.content} ${e.tags.join(' ')}`);
  const corpus = buildCorpus(texts);

  // Score each entry
  const scored: SearchResult[] = [];
  for (let i = 0; i < entries.length; i++) {
    const bm25 = bm25Score(corpus, i, queryTerms);
    if (bm25 <= 0) continue;

    const strength = calculateStrength(entries[i], now);
    const recency = recencyBoost(entries[i], now);

    // Composite: BM25 relevance * strength * recency
    // Normalise BM25 against query term count to keep scale consistent
    const normBm25 = queryTerms.length > 0 ? bm25 / queryTerms.length : bm25;
    const composite = normBm25 * (0.5 + 0.5 * strength) * (0.8 + 0.2 * recency);

    const tokens = estimateTokens(entries[i].content);

    scored.push({ entry: entries[i], score: composite, bm25, tokens });
  }

  // Sort by composite score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply token budget
  const results: SearchResult[] = [];
  let usedTokens = 0;

  for (const result of scored) {
    if (usedTokens + result.tokens > budget) continue;
    results.push(result);
    usedTokens += result.tokens;
  }

  return results;
}

/**
 * Update retrieval metadata on entries that were returned by a search.
 * Returns the mutated copies (caller must persist to disk).
 */
export function markRetrieved(entries: MemoryEntry[], now: Date = new Date()): MemoryEntry[] {
  return entries.map((e) => {
    const updated: MemoryEntry = {
      ...e,
      retrieval_count: e.retrieval_count + 1,
      last_retrieved: now.toISOString(),
      // Extend half-life by +2 days per retrieval (PLAN.md)
      half_life_days: e.half_life_days + 2,
    };
    updated.strength = calculateStrength(updated, now);
    return updated;
  });
}

/**
 * Compute text overlap ratio between two strings (Jaccard on token sets).
 */
export function textOverlap(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}
