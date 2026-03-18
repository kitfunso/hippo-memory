/**
 * BM25 search + optional embedding hybrid search for Hippo.
 * Zero external dependencies when embeddings are not available.
 */

import { MemoryEntry, calculateStrength } from './memory.js';
import {
  isEmbeddingAvailable,
  getEmbedding,
  cosineSimilarity,
  loadEmbeddingIndex,
} from './embeddings.js';

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
 * Hybrid search: BM25 + cosine similarity (when embeddings are available).
 * score = 0.4 * bm25_norm + 0.6 * cosine_sim  (with embeddings)
 * score = bm25_norm * strength * recency        (BM25-only fallback)
 *
 * embeddingWeight: weight for the cosine similarity component (0.0 to 1.0).
 */
export async function hybridSearch(
  query: string,
  entries: MemoryEntry[],
  options: {
    budget?: number;
    now?: Date;
    hippoRoot?: string;
    embeddingWeight?: number;
  } = {}
): Promise<SearchResult[]> {
  const now = options.now ?? new Date();
  const budget = options.budget ?? 4000;
  const embeddingWeight = options.embeddingWeight ?? 0.6;
  const bm25Weight = 1 - embeddingWeight;

  if (entries.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  // Build BM25 corpus
  const texts = entries.map((e) => `${e.content} ${e.tags.join(' ')}`);
  const corpus = buildCorpus(texts);

  // Score all entries with BM25
  const bm25Scores: number[] = entries.map((_, i) => bm25Score(corpus, i, queryTerms));
  const maxBm25 = Math.max(...bm25Scores, 1e-9);

  // Try to get embedding scores if available
  let useEmbeddings = false;
  let embeddingIndex: Record<string, number[]> = {};
  let queryVector: number[] = [];

  if (isEmbeddingAvailable() && options.hippoRoot) {
    try {
      queryVector = await getEmbedding(query);
      if (queryVector.length > 0) {
        embeddingIndex = loadEmbeddingIndex(options.hippoRoot);
        useEmbeddings = true;
      }
    } catch {
      // Fall through to BM25-only
    }
  }

  // Score each entry
  const scored: SearchResult[] = [];

  for (let i = 0; i < entries.length; i++) {
    const rawBm25 = bm25Scores[i];

    if (!useEmbeddings && rawBm25 <= 0) continue;

    const normBm25 = rawBm25 / maxBm25;
    const strength = calculateStrength(entries[i], now);
    const recency = recencyBoost(entries[i], now);

    let compositeScore: number;

    if (useEmbeddings) {
      const cached = embeddingIndex[entries[i].id];
      const cosine = cached && queryVector.length > 0
        ? cosineSimilarity(queryVector, cached)
        : 0;

      // Hybrid: weighted blend, then modulated by strength and recency
      const hybrid = bm25Weight * normBm25 + embeddingWeight * Math.max(0, cosine);
      compositeScore = hybrid * (0.5 + 0.5 * strength) * (0.8 + 0.2 * recency);
    } else {
      // Pure BM25 path: identical to original behavior
      const normQ = queryTerms.length > 0 ? rawBm25 / queryTerms.length : rawBm25;
      compositeScore = normQ * (0.5 + 0.5 * strength) * (0.8 + 0.2 * recency);
    }

    if (compositeScore <= 0) continue;

    const tokens = estimateTokens(entries[i].content);
    scored.push({ entry: entries[i], score: compositeScore, bm25: rawBm25, tokens });
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
 * Search entries using BM25 + strength + recency composite score.
 * When embeddings are available and hippoRoot is provided, uses hybrid scoring.
 * Returns results sorted by score, capped at token budget.
 *
 * Also updates retrieval metadata on returned entries (side effect: caller
 * must persist the updated entries).
 */
export function search(
  query: string,
  entries: MemoryEntry[],
  options: { budget?: number; now?: Date; hippoRoot?: string } = {}
): SearchResult[] {
  // Synchronous path: BM25 only (no async hybrid)
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
      // A stale memory that gets used again becomes live context.
      confidence: e.confidence === 'stale' ? 'observed' : e.confidence,
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
