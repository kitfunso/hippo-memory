/**
 * BM25 search + optional embedding hybrid search for Hippo.
 * Zero external dependencies when embeddings are not available.
 */

import { MemoryEntry, calculateStrength } from './memory.js';
import { extractPathTags, pathOverlapScore } from './path-context.js';
import { detectScope, scopeMatch } from './scope.js';
import {
  isEmbeddingAvailable,
  getEmbedding,
  cosineSimilarity,
  embeddingModelRequiresReindex,
  loadEmbeddingIndex,
  resolveEmbeddingModel,
} from './embeddings.js';
import { physicsScore as computePhysicsScores } from './physics.js';
import type { PhysicsParticle } from './physics.js';
import type { PhysicsConfig } from './physics-config.js';
import { DEFAULT_PHYSICS_CONFIG } from './physics-config.js';
import { loadPhysicsState } from './physics-state.js';
import { openHippoDb, closeHippoDb } from './db.js';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// ---------------------------------------------------------------------------
// BM25 implementation
// ---------------------------------------------------------------------------

/**
 * Tokenized BM25 corpus. Callers can pre-build this with `buildCorpus` once
 * and reuse across many `hybridSearch` calls on the same entry set — the
 * tokenization work is the bulk of per-query cost on large stores.
 */
export interface BM25Corpus {
  docs: string[][];        // tokenized documents
  avgLen: number;
  df: Map<string, number>; // document frequency per term
  N: number;               // total documents
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

export function buildCorpus(texts: string[]): BM25Corpus {
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
  cosine: number;         // cosine similarity (0 when embeddings not used)
  tokens: number;
  /** Populated when search is called with options.explain === true. */
  breakdown?: ScoreBreakdown;
}

export interface ScoreBreakdown {
  /**
   * - `hybrid`: BM25 blended with a non-zero cosine from a cached doc vector.
   * - `hybrid-no-vec`: Query was embedded but this doc had no cached vector,
   *   so the effective score came from BM25 alone even though weights say
   *   otherwise. Usually means `hippo embed` hasn't run on this memory.
   * - `bm25-only`: Embedding pipeline unavailable or the model requires re-index.
   * - `physics`: Scored by the physics engine (gravity + momentum + cluster).
   */
  mode: 'hybrid' | 'hybrid-no-vec' | 'bm25-only' | 'physics';
  /** BM25 score after normalization by max-in-corpus (0..1). */
  normBm25: number;
  /** Weight applied to BM25 in the hybrid blend. */
  bm25Weight: number;
  /** Weight applied to cosine in the hybrid blend. */
  embeddingWeight: number;
  /** Cosine similarity (0 when embeddings not used). */
  cosine: number;
  /** Blended base score before multipliers. */
  base: number;
  /** Multiplier from memory strength: 0.5 + 0.5*strength. */
  strengthMultiplier: number;
  /** Multiplier from age: 0.8 + 0.2*recencyBoost. */
  recencyMultiplier: number;
  /** 1.2 if tagged 'decision', else 1.0. */
  decisionBoost: number;
  /** 1.0..1.3 based on cwd path tag overlap. */
  pathBoost: number;
  /** 1.5 if scope matches, 0.5 if scope mismatches, 1.0 if neutral. */
  scopeBoost: number;
  /** Extra multiplier applied post-hybrid (e.g. 1.2x for local hits in a
   *  local+global merged search). 1.0 when not applicable. */
  sourceBump: number;
  /** Retrieval-time outcome personalization: 1 + 0.15*tanh(pos - neg), clipped
   *  to [0.85, 1.15]. Immediate nudge from `hippo outcome --good/--bad`.
   *  Separate from the slow strength-via-reward-factor path. */
  outcomeBoost: number;
  /** Pre-MMR rank (1-indexed). Only set when MMR re-ranking ran. */
  preMmrRank?: number;
  /** Post-MMR rank (1-indexed). Only set when MMR re-ranking ran. */
  postMmrRank?: number;
  /** Query terms that appeared verbatim in the doc. */
  matchedTerms: string[];
  /** Final composite score (= base * multipliers). */
  final: number;
  /** Age of the memory in whole days, at scoring time. */
  ageDays: number;
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
    explain?: boolean;
    /** Disable MMR re-ranking even when embeddings are available. */
    mmr?: boolean;
    /** MMR balance: 1.0 = pure relevance, 0.0 = pure diversity. Default 0.7. */
    mmrLambda?: number;
    /** Scoring mode: 'blend' (weighted sum of BM25+cosine, default) or
     *  'rrf' (reciprocal rank fusion - combines BM25 and cosine ranks
     *  instead of scores, more robust for long documents). */
    scoring?: 'blend' | 'rrf';
    /** Pre-built BM25 corpus from `buildCorpus`. Pass this across many
     *  queries on the same entry set to skip ~O(N*docLen) tokenization
     *  work per call. Must be built from the same `entries` in the same
     *  order (content + tags.join(' ')). */
    preparedCorpus?: BM25Corpus;
    /** Minimum number of results to return regardless of budget.
     *  Prevents budget saturation when memories are large. Default 1. */
    minResults?: number;
    /** Active scope for scope-boost scoring. Auto-detected if not provided. */
    scope?: string | null;
    /** Include superseded memories in results. Default false. */
    includeSuperseded?: boolean;
    /** Filter to memories current at this ISO date string. */
    asOf?: string;
  } = {}
): Promise<SearchResult[]> {
  const now = options.now ?? new Date();
  const budget = options.budget ?? 4000;
  const minResults = options.minResults ?? 1;
  const embeddingWeight = options.embeddingWeight ?? 0.6;
  const bm25Weight = 1 - embeddingWeight;
  const scoringMode = options.scoring ?? 'blend';
  const explain = options.explain ?? false;
  const mmrEnabled = options.mmr ?? true;
  const mmrLambda = options.mmrLambda ?? 0.7;

  // Bi-temporal filtering
  if (options.asOf) {
    const asOfDate = new Date(options.asOf);
    const successorValidFrom = new Map<string, string>();
    for (const e of entries) {
      if (e.superseded_by) {
        const successor = entries.find(s => s.id === e.superseded_by);
        if (successor) successorValidFrom.set(e.id, successor.valid_from);
      }
    }
    entries = entries.filter(e => {
      if (new Date(e.valid_from) > asOfDate) return false;
      if (!e.superseded_by) return true;
      const succVf = successorValidFrom.get(e.id);
      return succVf ? new Date(succVf) > asOfDate : true;
    });
  } else if (!options.includeSuperseded) {
    entries = entries.filter(e => !e.superseded_by);
  }

  if (entries.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  // Build BM25 corpus (or reuse one the caller already built).
  const corpus = options.preparedCorpus
    ?? buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));

  // Score all entries with BM25
  const bm25Scores: number[] = entries.map((_, i) => bm25Score(corpus, i, queryTerms));
  const maxBm25 = bm25Scores.reduce((a, b) => Math.max(a, b), 1e-9);

  // Try to get embedding scores if available
  let useEmbeddings = false;
  let embeddingIndex: Record<string, number[]> = {};
  let queryVector: number[] = [];

  if (isEmbeddingAvailable() && options.hippoRoot) {
    try {
      const model = resolveEmbeddingModel(options.hippoRoot);
      if (!embeddingModelRequiresReindex(options.hippoRoot, model)) {
        queryVector = await getEmbedding(query, model);
        if (queryVector.length > 0) {
          embeddingIndex = loadEmbeddingIndex(options.hippoRoot);
          useEmbeddings = true;
        }
      }
    } catch {
      // Fall through to BM25-only
    }
  }

  // Compute cosine similarities for RRF ranking (need all before scoring)
  const cosineScores: number[] = new Array(entries.length).fill(0);
  const hadCachedVecs: boolean[] = new Array(entries.length).fill(false);
  if (useEmbeddings) {
    for (let i = 0; i < entries.length; i++) {
      const cached = embeddingIndex[entries[i].id];
      hadCachedVecs[i] = Boolean(cached && queryVector.length > 0);
      cosineScores[i] = hadCachedVecs[i]
        ? Math.max(0, cosineSimilarity(queryVector, cached))
        : 0;
    }
  }

  // For RRF: build rank maps from BM25 and cosine orderings
  let rrfScores: Map<number, number> | null = null;
  if (useEmbeddings && scoringMode === 'rrf') {
    const RRF_K = 60;
    const bm25Ranked = entries.map((_, i) => i).filter(i => bm25Scores[i] > 0 || cosineScores[i] > 0);
    bm25Ranked.sort((a, b) => bm25Scores[b] - bm25Scores[a]);
    const cosineRanked = entries.map((_, i) => i).filter(i => bm25Scores[i] > 0 || cosineScores[i] > 0);
    cosineRanked.sort((a, b) => cosineScores[b] - cosineScores[a]);

    const bm25RankMap = new Map<number, number>();
    bm25Ranked.forEach((idx, rank) => bm25RankMap.set(idx, rank + 1));
    const cosineRankMap = new Map<number, number>();
    cosineRanked.forEach((idx, rank) => cosineRankMap.set(idx, rank + 1));

    rrfScores = new Map();
    const allCandidates = new Set([...bm25Ranked, ...cosineRanked]);
    for (const idx of allCandidates) {
      const bm25Rank = bm25RankMap.get(idx) ?? (entries.length + 1);
      const cosineRank = cosineRankMap.get(idx) ?? (entries.length + 1);
      rrfScores.set(idx, bm25Weight / (RRF_K + bm25Rank) + embeddingWeight / (RRF_K + cosineRank));
    }
  }

  // Score each entry
  const scored: SearchResult[] = [];
  const currentPathTags = extractPathTags(process.cwd());
  const activeScope = options.scope !== undefined ? options.scope : detectScope();
  const queryTermSet = new Set(queryTerms);

  for (let i = 0; i < entries.length; i++) {
    const rawBm25 = bm25Scores[i];
    const cosineScore = cosineScores[i];
    const hadCachedVec = hadCachedVecs[i];

    if (!useEmbeddings && rawBm25 <= 0) continue;

    const normBm25 = rawBm25 / maxBm25;
    const strength = calculateStrength(entries[i], now);
    const recency = recencyBoost(entries[i], now);
    const strengthMultiplier = 0.5 + 0.5 * strength;
    const recencyMultiplier = 0.8 + 0.2 * recency;

    let compositeScore: number;
    let base: number;
    let modeLabel: 'hybrid' | 'hybrid-no-vec' | 'bm25-only';

    if (useEmbeddings) {
      if (rrfScores) {
        base = rrfScores.get(i) ?? 0;
      } else {
        base = bm25Weight * normBm25 + embeddingWeight * cosineScore;
      }
      compositeScore = base * strengthMultiplier * recencyMultiplier;
      modeLabel = hadCachedVec ? 'hybrid' : 'hybrid-no-vec';
    } else {
      base = queryTerms.length > 0 ? rawBm25 / queryTerms.length : rawBm25;
      compositeScore = base * strengthMultiplier * recencyMultiplier;
      modeLabel = 'bm25-only';
    }

    // Decision-tagged memories get a 1.2x recall boost
    const decisionBoost = entries[i].tags.includes('decision') ? 1.2 : 1.0;
    compositeScore *= decisionBoost;

    // Path-based boost: memories tagged with matching path segments get up to 1.3x
    const memPathTags = entries[i].tags.filter(t => t.startsWith('path:'));
    const pathScore = pathOverlapScore(memPathTags, currentPathTags);
    const pathBoost = 1.0 + (pathScore * 0.3);
    compositeScore *= pathBoost;

    // Retrieval-time outcome personalization: nudge up/down from user feedback.
    // Distinct from reward-factor-via-strength (slow); this is immediate.
    const pos = entries[i].outcome_positive ?? 0;
    const neg = entries[i].outcome_negative ?? 0;
    const outcomeBoost = pos === 0 && neg === 0
      ? 1.0
      : Math.max(0.85, Math.min(1.15, 1 + 0.15 * Math.tanh((pos - neg) / 2)));
    compositeScore *= outcomeBoost;

    // Scope boost: memories tagged with the active scope get 1.5x; mismatching scopes get 0.5x
    const scopeSignal = scopeMatch(entries[i].tags, activeScope);
    const scopeBoost = scopeSignal === 1 ? 1.5 : scopeSignal === -1 ? 0.5 : 1.0;
    compositeScore *= scopeBoost;

    if (compositeScore <= 0) continue;

    const tokens = estimateTokens(entries[i].content);
    const result: SearchResult = {
      entry: entries[i],
      score: compositeScore,
      bm25: rawBm25,
      cosine: cosineScore,
      tokens,
    };

    if (explain) {
      const docTerms = new Set(tokenize(`${entries[i].content} ${entries[i].tags.join(' ')}`));
      const matchedTerms: string[] = [];
      for (const t of queryTermSet) if (docTerms.has(t)) matchedTerms.push(t);
      const ageDays = Math.max(
        0,
        Math.floor((now.getTime() - new Date(entries[i].created).getTime()) / 86_400_000),
      );
      result.breakdown = {
        mode: modeLabel,
        normBm25,
        bm25Weight: useEmbeddings ? bm25Weight : 1,
        embeddingWeight: useEmbeddings ? embeddingWeight : 0,
        cosine: cosineScore,
        base,
        strengthMultiplier,
        recencyMultiplier,
        decisionBoost,
        pathBoost,
        scopeBoost,
        sourceBump: 1,
        outcomeBoost,
        matchedTerms,
        final: compositeScore,
        ageDays,
      };
    }

    scored.push(result);
  }

  // Sort by composite score descending
  scored.sort((a, b) => b.score - a.score);

  // MMR re-ranking: de-cluster near-duplicates by trading relevance for
  // diversity. Only applies when embeddings are loaded (doc-to-doc similarity
  // is via cosine of cached vectors); otherwise we return the pure-relevance
  // ordering unchanged.
  //
  // MMR is O(K^2) in cosine similarity ops, which on large corpora (1000+
  // candidates) dominates query time. Cap the re-ranking window to the top
  // relevance-scored candidates — anything below top-K was never going to
  // surface anyway after budget filtering.
  const MMR_CANDIDATE_CAP = 100;
  const applyMmr = mmrEnabled && useEmbeddings && scored.length > 1 && mmrLambda < 1;
  let ordered: SearchResult[];
  if (applyMmr) {
    const head = scored.slice(0, MMR_CANDIDATE_CAP);
    const tail = scored.slice(MMR_CANDIDATE_CAP);
    ordered = [...mmrRerank(head, embeddingIndex, mmrLambda, explain), ...tail];
  } else {
    ordered = scored;
  }

  // Apply token budget (guarantee at least minResults items)
  const results: SearchResult[] = [];
  let usedTokens = 0;

  for (let i = 0; i < ordered.length; i++) {
    const tokens = ordered[i].tokens;
    if (results.length >= minResults && usedTokens + tokens > budget) continue;
    usedTokens += tokens;
    results.push(ordered[i]);
  }

  return results;
}

/**
 * MMR (Maximal Marginal Relevance) re-ranking.
 *
 * Iteratively picks the candidate that maximises
 *   lambda * relevance - (1 - lambda) * max(cos(cand, picked))
 *
 * Inputs must already be sorted by relevance descending. When `explain` is
 * true, attaches `preMmrRank` / `postMmrRank` to each result's breakdown.
 * Exported for unit tests; production callers go through hybridSearch.
 */
export function mmrRerank(
  scored: SearchResult[],
  embeddingIndex: Record<string, number[]>,
  lambda: number,
  explain: boolean,
): SearchResult[] {
  if (scored.length === 0) return scored;

  const maxScore = scored[0].score || 1;
  const normScore = scored.map((r) => r.score / maxScore);
  const vectors = scored.map((r) => embeddingIndex[r.entry.id] ?? null);

  const picked: SearchResult[] = [];
  const remaining = new Set<number>(scored.map((_, i) => i));

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;
    for (const i of remaining) {
      const rel = normScore[i];
      let maxSim = 0;
      const vi = vectors[i];
      if (vi) {
        for (const p of picked) {
          const vp = embeddingIndex[p.entry.id];
          if (!vp || vp.length !== vi.length) continue;
          const sim = Math.max(0, cosineSimilarity(vi, vp));
          if (sim > maxSim) maxSim = sim;
        }
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    remaining.delete(bestIdx);
    picked.push(scored[bestIdx]);
  }

  if (explain) {
    const preRank = new Map<string, number>();
    scored.forEach((r, i) => preRank.set(r.entry.id, i + 1));
    picked.forEach((r, i) => {
      if (r.breakdown) {
        r.breakdown.preMmrRank = preRank.get(r.entry.id);
        r.breakdown.postMmrRank = i + 1;
      }
    });
  }

  return picked;
}

/**
 * Physics-based search: scores memories using gravitational force, momentum,
 * and cluster amplification. Falls back to classic hybrid for memories
 * without physics state.
 */
export async function physicsSearch(
  query: string,
  entries: MemoryEntry[],
  options: {
    budget?: number;
    now?: Date;
    hippoRoot?: string;
    physicsConfig?: PhysicsConfig;
    queryEmbedding?: number[]; // pre-computed query vector (for testing/benchmarks)
    explain?: boolean;
    minResults?: number;
    /** Active scope for scope-boost scoring. Auto-detected if not provided. */
    scope?: string | null;
  } = {}
): Promise<SearchResult[]> {
  const now = options.now ?? new Date();
  const budget = options.budget ?? 4000;
  const minResults = options.minResults ?? 1;
  const config = options.physicsConfig ?? DEFAULT_PHYSICS_CONFIG;
  const explain = options.explain ?? false;

  if (entries.length === 0 || !options.hippoRoot) return [];

  // Get query embedding (use pre-computed if provided)
  let queryVector = options.queryEmbedding ?? [];
  if (queryVector.length === 0) {
    if (!isEmbeddingAvailable()) {
      return hybridSearch(query, entries, options);
    }
    const model = resolveEmbeddingModel(options.hippoRoot);
    if (embeddingModelRequiresReindex(options.hippoRoot, model)) {
      return hybridSearch(query, entries, options);
    }
    queryVector = await getEmbedding(query, model);
    if (queryVector.length === 0) {
      return hybridSearch(query, entries, options);
    }
  }

  // Load physics state
  let physicsMap: Map<string, PhysicsParticle>;
  try {
    const db = openHippoDb(options.hippoRoot);
    try {
      physicsMap = loadPhysicsState(db);
    } finally {
      closeHippoDb(db);
    }
  } catch {
    return hybridSearch(query, entries, options);
  }

  // Split entries into physics-enabled and classic
  const physicsEntries: MemoryEntry[] = [];
  const physicsParticles: PhysicsParticle[] = [];
  const classicEntries: MemoryEntry[] = [];

  for (const entry of entries) {
    const particle = physicsMap.get(entry.id);
    if (
      particle
      && particle.position.length > 0
      && particle.position.length === queryVector.length
      && particle.velocity.length === queryVector.length
    ) {
      physicsEntries.push(entry);
      physicsParticles.push(particle);
    } else {
      classicEntries.push(entry);
    }
  }

  // Score physics-enabled memories
  const physicsResults: SearchResult[] = [];
  if (physicsParticles.length > 0) {
    const scored = computePhysicsScores(physicsParticles, queryVector, config);
    const entryMap = new Map(physicsEntries.map(e => [e.id, e]));

    for (const s of scored) {
      if (s.finalScore <= 0) continue;
      const entry = entryMap.get(s.memoryId);
      if (!entry) continue;
      const result: SearchResult = {
        entry,
        score: s.finalScore,
        bm25: 0,
        cosine: s.baseScore,
        tokens: estimateTokens(entry.content),
      };
      if (explain) {
        const ageDays = Math.max(
          0,
          Math.floor((now.getTime() - new Date(entry.created).getTime()) / 86_400_000),
        );
        result.breakdown = {
          mode: 'physics',
          normBm25: 0,
          bm25Weight: 0,
          embeddingWeight: 1,
          cosine: s.baseScore,
          base: s.baseScore,
          strengthMultiplier: 1,
          recencyMultiplier: 1,
          decisionBoost: 1,
          pathBoost: 1,
          scopeBoost: 1,
          sourceBump: 1,
          outcomeBoost: 1,
          matchedTerms: [],
          final: s.finalScore,
          ageDays,
        };
      }
      physicsResults.push(result);
    }
  }

  // Score classic memories (no physics state)
  const classicResults = classicEntries.length > 0
    ? await hybridSearch(query, classicEntries, { ...options, budget: Infinity, explain })
    : [];

  // Normalize both pools to [0, 1] and merge
  const merged = mergeScorePools(physicsResults, classicResults);

  // Sort and apply budget
  merged.sort((a, b) => b.score - a.score);

  const results: SearchResult[] = [];
  let usedTokens = 0;
  for (let i = 0; i < merged.length; i++) {
    const tokens = merged[i].tokens;
    if (results.length >= minResults && usedTokens + tokens > budget) continue;
    usedTokens += tokens;
    results.push(merged[i]);
  }

  return results;
}

/** Normalize two score pools to [0,1] and combine. */
function mergeScorePools(poolA: SearchResult[], poolB: SearchResult[]): SearchResult[] {
  const maxA = poolA.reduce((m, r) => Math.max(m, r.score), 1e-9);
  const maxB = poolB.reduce((m, r) => Math.max(m, r.score), 1e-9);

  const merged: SearchResult[] = [];
  for (const r of poolA) {
    merged.push({ ...r, score: r.score / maxA });
  }
  for (const r of poolB) {
    merged.push({ ...r, score: r.score / maxB });
  }
  return merged;
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
  options: { budget?: number; now?: Date; hippoRoot?: string; minResults?: number; includeSuperseded?: boolean; asOf?: string } = {}
): SearchResult[] {
  // Synchronous path: BM25 only (no async hybrid)
  const now = options.now ?? new Date();
  const budget = options.budget ?? 4000;
  const minResults = options.minResults ?? 1;

  // Bi-temporal filtering
  if (options.asOf) {
    const asOfDate = new Date(options.asOf);
    const successorValidFrom = new Map<string, string>();
    for (const e of entries) {
      if (e.superseded_by) {
        const successor = entries.find(s => s.id === e.superseded_by);
        if (successor) successorValidFrom.set(e.id, successor.valid_from);
      }
    }
    entries = entries.filter(e => {
      if (new Date(e.valid_from) > asOfDate) return false;
      if (!e.superseded_by) return true;
      const succVf = successorValidFrom.get(e.id);
      return succVf ? new Date(succVf) > asOfDate : true;
    });
  } else if (!options.includeSuperseded) {
    entries = entries.filter(e => !e.superseded_by);
  }

  if (entries.length === 0) return [];

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  // Build corpus from all entries (content + tags joined)
  const texts = entries.map((e) => `${e.content} ${e.tags.join(' ')}`);
  const corpus = buildCorpus(texts);

  // Score each entry
  const scored: SearchResult[] = [];
  const currentPathTagsSync = extractPathTags(process.cwd());
  const activeScopeSync = detectScope();
  for (let i = 0; i < entries.length; i++) {
    const bm25 = bm25Score(corpus, i, queryTerms);
    if (bm25 <= 0) continue;

    const strength = calculateStrength(entries[i], now);
    const recency = recencyBoost(entries[i], now);

    // Composite: BM25 relevance * strength * recency
    // Normalise BM25 against query term count to keep scale consistent
    const normBm25 = queryTerms.length > 0 ? bm25 / queryTerms.length : bm25;
    let composite = normBm25 * (0.5 + 0.5 * strength) * (0.8 + 0.2 * recency);

    // Decision-tagged memories get a 1.2x recall boost
    const decisionBoost = entries[i].tags.includes('decision') ? 1.2 : 1.0;
    composite *= decisionBoost;

    // Path-based boost: memories tagged with matching path segments get up to 1.3x
    const memPathTagsSync = entries[i].tags.filter(t => t.startsWith('path:'));
    const pathScoreSync = pathOverlapScore(memPathTagsSync, currentPathTagsSync);
    const pathBoostSync = 1.0 + (pathScoreSync * 0.3);
    composite *= pathBoostSync;

    // Scope boost (sync path)
    const scopeSignalSync = scopeMatch(entries[i].tags, activeScopeSync);
    const scopeBoostSync = scopeSignalSync === 1 ? 1.5 : scopeSignalSync === -1 ? 0.5 : 1.0;
    composite *= scopeBoostSync;

    const tokens = estimateTokens(entries[i].content);

    scored.push({ entry: entries[i], score: composite, bm25, cosine: 0, tokens });
  }

  // Sort by composite score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply token budget
  const results: SearchResult[] = [];
  let usedTokens = 0;

  for (let i = 0; i < scored.length; i++) {
    const tokens = scored[i].tokens;
    if (results.length >= minResults && usedTokens + tokens > budget) continue;
    usedTokens += tokens;
    results.push(scored[i]);
  }

  return results;
}

/**
 * Update retrieval metadata on entries that were returned by a search.
 * Returns the mutated copies (caller must persist to disk).
 */
export function markRetrieved(entries: MemoryEntry[], now: Date = new Date()): MemoryEntry[] {
  return entries.map((e) => {
    if (e.superseded_by) return e;
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

// ---------------------------------------------------------------------------
// Match explanation (--why support)
// ---------------------------------------------------------------------------

export interface MatchExplanation {
  /** Human-readable reason string */
  reason: string;
  /** Which query terms matched in the document (BM25 component) */
  matchedTerms: string[];
  /** Whether BM25 contributed to the score */
  hasBm25: boolean;
  /** Whether embedding similarity contributed to the score */
  hasEmbedding: boolean;
  /** Raw cosine similarity (0 when embeddings not used) */
  cosineSimilarity: number;
}

/**
 * Explain why a search result matched a query.
 * Computes which query terms overlapped with the document and whether
 * BM25 and/or embedding similarity contributed to the composite score.
 */
export function explainMatch(query: string, result: SearchResult): MatchExplanation {
  const queryTerms = new Set(tokenize(query));
  const docTerms = new Set(tokenize(`${result.entry.content} ${result.entry.tags.join(' ')}`));

  const matchedTerms: string[] = [];
  for (const term of queryTerms) {
    if (docTerms.has(term)) {
      matchedTerms.push(term);
    }
  }

  const hasBm25 = result.bm25 > 0;
  const hasEmbedding = result.cosine > 0;

  const parts: string[] = [];
  if (hasBm25) {
    parts.push(`BM25: matched terms [${matchedTerms.join(', ')}]`);
  }
  if (hasEmbedding) {
    parts.push(`embedding similarity: ${result.cosine.toFixed(3)}`);
  }
  if (parts.length === 0) {
    parts.push('no direct term or embedding match');
  }

  return {
    reason: parts.join('; '),
    matchedTerms,
    hasBm25,
    hasEmbedding,
    cosineSimilarity: result.cosine,
  };
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
