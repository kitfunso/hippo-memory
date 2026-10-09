import type { MemoryEntry } from '../core/memory.js';
import { rrfFuse } from './rrf.js';
import { graphRankStream, selectGraphSeeds, DEFAULT_GRAPH_SEED_COUNT } from '../graph/stream.js';
import { compareEntryIdentity } from '../core/compare.js';
import type { DenseScores } from './vector.js';

/** Opt-in third RRF list ranking in-pool candidates by graph proximity to the strong lexical seeds. */
export interface GraphStreamOptions {
  /** RRF weight for the graph list. Required (opt-in is explicit; no implicit default). */
  weight: number;
  tenantId: string;
  /** Global store root, when distinct (where global seeds' graph lives). */
  globalRoot?: string;
  hops?: number;
  decay?: number;
  maxNeighbors?: number;
  /** # of top lexical seeds to expand from. Default DEFAULT_GRAPH_SEED_COUNT. */
  seedCount?: number;
}

export interface FusionInput {
  entries: MemoryEntry[];
  bm25Scores: number[];
  dense: DenseScores;
  bm25Weight: number;
  embeddingWeight: number;
  hippoRoot?: string;
  graphStream?: GraphStreamOptions;
}

// Score desc, then entry identity, so ties cannot leak fresh-ingest order into graph seeds or RRF ranks.
function rankBy(eligible: number[], scores: number[], entries: MemoryEntry[]): number[] {
  return [...eligible].sort((a, b) => {
    const d = scores[b] - scores[a];
    return d !== 0 ? d : compareEntryIdentity(entries[a], entries[b]);
  });
}

/** Reciprocal rank fusion of the BM25 and dense rankings, plus the graph list when it ranks anything. */
export function fuseRanks(input: FusionInput): Map<number, number> {
  const { entries, bm25Scores, dense } = input;
  const eligible = entries.map((_, i) => i).filter((i) => bm25Scores[i] > 0 || dense.cosine[i] > 0);
  const bm25Ranked = rankBy(eligible, bm25Scores, entries);
  const cosineRanked = rankBy(eligible, dense.cosine, entries);
  const graphRanked = graphRanking(input, eligible.length, bm25Ranked, cosineRanked);
  // absentRank stays entries.length + 1 rather than rrfFuse's longest-list default.
  const opts = { absentRank: entries.length + 1 };
  // An all-absent third list would add a constant the later multipliers make non-uniform, so an empty one is skipped.
  return graphRanked.length > 0
    ? rrfFuse([bm25Ranked, cosineRanked, graphRanked], [input.bm25Weight, input.embeddingWeight, input.graphStream?.weight ?? 0], opts)
    : rrfFuse([bm25Ranked, cosineRanked], [input.bm25Weight, input.embeddingWeight], opts);
}

function graphRanking(input: FusionInput, eligibleCount: number, bm25Ranked: number[], cosineRanked: number[]): number[] {
  const gs = input.graphStream;
  // Without doc vectors the dense ranking is just entry order, so seeds drawn from it would mean nothing.
  const hasDocVectors = input.dense.hadVec.some(Boolean);
  if (!gs || gs.weight <= 0 || !input.hippoRoot || !hasDocVectors) return [];
  const seedCount = Math.min(gs.seedCount ?? DEFAULT_GRAPH_SEED_COUNT, eligibleCount);
  const seeds = selectGraphSeeds(bm25Ranked, cosineRanked, seedCount);
  return graphRankStream(input.entries, seeds, {
    hippoRoot: input.hippoRoot,
    tenantId: gs.tenantId,
    globalRoot: gs.globalRoot,
    hops: gs.hops,
    decay: gs.decay,
    maxNeighbors: gs.maxNeighbors,
  });
}
