import { cosineOf } from '../store/embeddings/index.js';
import type { RerankerFn, RerankerOptions } from '../rerankers/types.js';
import type { SearchResult } from '../core/search-types.js';

const DEFAULT_RERANK_TOP_K = 50;

// MMR is O(K^2) cosine ops; candidates below this window never survive budget filtering anyway.
const MMR_CANDIDATE_CAP = 100;

/** MMR: repeatedly picks the candidate maximising lambda * relevance - (1 - lambda) * max(cos(cand, picked)).
 *  Input must be sorted by relevance; strict `>` keeps ties first-wins, so a deterministic input stays deterministic. */
export function mmrRerank(
  scored: SearchResult[],
  embeddingIndex: Record<string, ArrayLike<number>>,
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
      const maxSim = maxSimilarityToPicked(vectors[i], picked, embeddingIndex);
      const mmr = lambda * normScore[i] - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    remaining.delete(bestIdx);
    picked.push(scored[bestIdx]);
  }

  if (explain) attachMmrRanks(scored, picked);
  return picked;
}

function maxSimilarityToPicked(vi: ArrayLike<number> | null, picked: SearchResult[], embeddingIndex: Record<string, ArrayLike<number>>): number {
  let maxSim = 0;
  if (!vi) return maxSim;
  for (const p of picked) {
    const vp = embeddingIndex[p.entry.id];
    if (!vp || vp.length !== vi.length) continue;
    const sim = Math.max(0, cosineOf(vi, vp));
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim;
}

function attachMmrRanks(scored: SearchResult[], picked: SearchResult[]): void {
  const preRank = new Map<string, number>();
  scored.forEach((r, i) => preRank.set(r.entry.id, i + 1));
  picked.forEach((r, i) => {
    if (r.breakdown) {
      r.breakdown.preMmrRank = preRank.get(r.entry.id);
      r.breakdown.postMmrRank = i + 1;
    }
  });
}

/** MMR over the top window only; the tail keeps its relevance order. */
export function applyMmrWindow(
  scored: SearchResult[], embeddingIndex: Record<string, ArrayLike<number>>, lambda: number, explain: boolean,
): SearchResult[] {
  const head = scored.slice(0, MMR_CANDIDATE_CAP);
  const tail = scored.slice(MMR_CANDIDATE_CAP);
  return [...mmrRerank(head, embeddingIndex, lambda, explain), ...tail];
}

/** Runs the reranker over the top `topK` (default 50) and stamps pre and post ranks; see src/rerankers/types.ts. */
export async function applyReranker(
  query: string, ordered: SearchResult[], reranker: RerankerFn, rerankerOptions?: RerankerOptions,
): Promise<SearchResult[]> {
  const topK = rerankerOptions?.topK ?? DEFAULT_RERANK_TOP_K;
  const head = ordered.slice(0, topK).map((r, i) => ({ ...r, preRerankRank: i + 1 }));
  const tail = ordered.slice(topK);
  const reranked = await reranker(query, head, { ...rerankerOptions, topK });
  return [...reranked.map((r, i) => ({ ...r, postRerankRank: i + 1 })), ...tail];
}
