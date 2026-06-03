/**
 * L1 — graph-retrieval ranked-list stream for RRF fusion
 * (docs/plans/2026-06-02-l1-graph-rrf-stream.md).
 *
 * READ-ONLY consumer of the E3 graph substrate (entities/relations built by E3.1,
 * guarded by E3.3). Produces a ranked list of `entries[]` indices ordered by graph
 * proximity to the strong lexical seeds, for use as a 3rd fusion input to `rrfFuse`
 * beside BM25 + dense (src/search.ts hybridSearch, scoring:'rrf').
 *
 * DISTINCT from graph-recall.ts: that INJECTS out-of-pool neighbours post-hoc; this
 * RE-RANKS within the already-filtered candidate pool. It only assigns ranks to
 * entries that are (a) graph-reached from a seed AND (b) present in `entries[]`. Seeds
 * themselves are never scored (they already rank via BM25/dense; scoring them would
 * double-count and dilute the orthogonal graph signal).
 *
 * Reuses the E3.2 BFS traversal shape from graph-recall.ts (loadEntitiesByMemoryId
 * seeds -> loadNeighborRelations BFS both directions, per-hop fanout cap, visited set
 * -> loadEntitiesByIds to resolve reached -> memoryId). Expands across the local AND
 * global stores. Pure reads (SELECTs only via graph.ts helpers), so the E3.3
 * check-graph-writes lint permits this module living outside graph.ts.
 *
 * The graph stream's score scale (1/lexRank seed strength x decay^hops) only sets the
 * WITHIN-graph-stream ORDERING; RRF then re-ranks the list by 1/(k + graphRank), so the
 * absolute magnitude is washed out by fusion. Do not tune the scale expecting a
 * fused-score effect — only the induced order matters.
 */
import type { MemoryEntry } from './memory.js';
import {
  loadEntitiesByMemoryId,
  loadEntitiesByIds,
  loadNeighborRelations,
} from './graph.js';
import { MAX_HOPS, DEFAULT_MAX_NEIGHBORS } from './graph-recall.js';

/** Default hops expanded from each seed (MVP; hard cap MAX_HOPS=3 reused from graph-recall). */
export const DEFAULT_GRAPH_HOPS = 2;
/** Default per-hop multiplicative decay applied to the seed strength. */
export const DEFAULT_GRAPH_DECAY = 0.5;
/** Default number of top lexical seeds expanded from. */
export const DEFAULT_GRAPH_SEED_COUNT = 10;
/** Recommended RRF weight for the graph stream — a CLI-only convenience default. The
 *  library `graphStream.weight` option stays REQUIRED (opt-in is explicit). */
export const DEFAULT_GRAPH_STREAM_WEIGHT = 0.5;

/** A lexical seed to expand the graph from: a candidate index + its lexical strength. */
export interface GraphSeed {
  /** Index into the caller's `entries[]`. */
  index: number;
  /** Lexical strength (1/lexRank); higher = stronger seed. Propagated x decay^hops. */
  strength: number;
}

export interface GraphStreamOpts {
  hippoRoot: string;
  tenantId: string;
  /** The global store root, when distinct + initialized (where global seeds' graph lives). */
  globalRoot?: string;
  /** Hops to expand from each seed. Clamped to [1, MAX_HOPS]. Default DEFAULT_GRAPH_HOPS. */
  hops?: number;
  /** Per-hop multiplicative decay on the seed strength. Default DEFAULT_GRAPH_DECAY. */
  decay?: number;
  /** Per-hop fanout cap. Default DEFAULT_MAX_NEIGHBORS. */
  maxNeighbors?: number;
}

/**
 * Pick the top `seedCount` candidates by best lexical rank (lowest position across the
 * BM25 and dense ranked lists), with strength = 1/(bestRank + 1). Pure; exported for
 * direct unit testing. A candidate present in either ranked list is eligible.
 */
export function selectGraphSeeds(
  bm25Ranked: ReadonlyArray<number>,
  cosineRanked: ReadonlyArray<number>,
  seedCount: number,
): GraphSeed[] {
  if (seedCount <= 0) return [];
  const bestPos = new Map<number, number>();
  const consider = (list: ReadonlyArray<number>) => {
    for (let p = 0; p < list.length; p++) {
      const idx = list[p];
      const prev = bestPos.get(idx);
      if (prev === undefined || p < prev) bestPos.set(idx, p);
    }
  };
  consider(bm25Ranked);
  consider(cosineRanked);
  return [...bestPos.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]) // best rank asc, then index asc (deterministic)
    .slice(0, seedCount)
    .map(([index, best]) => ({ index, strength: 1 / (best + 1) }));
}

/**
 * Accumulate per-entryIndex graph-proximity scores from ONE store's graph into
 * `graphScore`. Pure reads. `seeds` are the lexical seeds (index + strength); only the
 * seeds whose entities live in THIS store are expanded. The origin seed strength is
 * carried UNCHANGED along each BFS path; the per-hop decay is applied as decay^depth so
 * a neighbour's score = originSeedStrength x decay^(graph distance).
 */
function accumulateForRoot(
  root: string,
  seeds: ReadonlyArray<GraphSeed>,
  entries: ReadonlyArray<MemoryEntry>,
  memIdToIndex: ReadonlyMap<string, number>,
  graphScore: Map<number, number>,
  hops: number,
  decay: number,
  maxNeighbors: number,
  tenantId: string,
): void {
  if (seeds.length === 0) return;
  // The strongest seed strength per source memory id (a memId could appear once, but
  // guard against dup indices mapping to the same memId).
  const strengthByMemId = new Map<string, number>();
  for (const s of seeds) {
    const memId = entries[s.index].id;
    strengthByMemId.set(memId, Math.max(strengthByMemId.get(memId) ?? 0, s.strength));
  }
  const seedEntities = loadEntitiesByMemoryId(root, tenantId, [...strengthByMemId.keys()]);
  if (seedEntities.length === 0) return;

  // entityId -> origin seed strength (carried unchanged along the path). A seed entity is
  // loaded by memory id, so its memoryId is non-null here; the guard keeps the widened
  // (string | null) type honest (a null-memory entity is not a lexical seed).
  const originStrength = new Map<number, number>();
  for (const e of seedEntities) {
    if (e.memoryId === null) continue;
    const st = strengthByMemId.get(e.memoryId) ?? 0;
    originStrength.set(e.id, Math.max(originStrength.get(e.id) ?? 0, st));
  }

  const visited = new Set<number>(seedEntities.map((e) => e.id)); // seeds never re-reached
  const reachedScore = new Map<number, number>();                 // entityId -> best score
  let frontier: number[] = seedEntities.map((e) => e.id);
  let frontierStrength = new Map<number, number>(originStrength);  // entityId -> seed strength

  for (let depth = 1; depth <= hops && frontier.length > 0; depth++) {
    const frontierSet = new Set(frontier);
    const rels = loadNeighborRelations(root, tenantId, frontier, {
      limit: Math.max(maxNeighbors, maxNeighbors * frontier.length),
    });
    const hopFactor = Math.pow(decay, depth);
    // Pass 1: accumulate the STRONGEST reaching-seed strength per new neighbour across ALL
    // relations at this depth BEFORE committing any to `visited` (codex P2). Marking a node
    // visited mid-loop would lock it to whichever relation SQLite returned first, so a later
    // edge from a STRONGER lexical seed would be dropped and the neighbour mis-scored. A node
    // already in `visited` was committed at an earlier (shorter) depth and keeps that score.
    const bestStrengthThisDepth = new Map<number, number>();
    for (const rel of rels) {
      const fromIn = frontierSet.has(rel.fromEntityId);
      const toIn = frontierSet.has(rel.toEntityId);
      let neighborId: number;
      let reacherId: number;
      if (fromIn && !toIn) { neighborId = rel.toEntityId; reacherId = rel.fromEntityId; }
      else if (toIn && !fromIn) { neighborId = rel.fromEntityId; reacherId = rel.toEntityId; }
      else continue;
      if (visited.has(neighborId)) continue;
      const seedStrength = frontierStrength.get(reacherId) ?? originStrength.get(reacherId) ?? 0;
      bestStrengthThisDepth.set(neighborId, Math.max(bestStrengthThisDepth.get(neighborId) ?? 0, seedStrength));
    }
    // Pass 2: commit strongest-first (then id asc — deterministic), so the per-hop fanout cap
    // keeps the highest-scoring neighbours rather than whichever SQLite happened to return.
    const nextFrontier: number[] = [];
    const nextStrength = new Map<number, number>();
    const ordered = [...bestStrengthThisDepth.keys()].sort((a, b) => {
      const d = bestStrengthThisDepth.get(b)! - bestStrengthThisDepth.get(a)!;
      return d !== 0 ? d : a - b;
    });
    for (const neighborId of ordered) {
      if (nextFrontier.length >= maxNeighbors) break; // per-hop fanout cap (strongest kept)
      const seedStrength = bestStrengthThisDepth.get(neighborId)!;
      visited.add(neighborId);
      reachedScore.set(neighborId, Math.max(reachedScore.get(neighborId) ?? 0, seedStrength * hopFactor));
      nextStrength.set(neighborId, seedStrength);
      nextFrontier.push(neighborId);
    }
    frontier = nextFrontier;
    frontierStrength = nextStrength;
  }
  if (reachedScore.size === 0) return;

  // Reached entity ids -> source memory ids -> in-pool entry indices.
  const reachedEntities = loadEntitiesByIds(root, tenantId, [...reachedScore.keys()]);
  for (const ent of reachedEntities) {
    if (ent.memoryId === null) continue;         // mirror-less node: no pool memory to re-rank
    const idx = memIdToIndex.get(ent.memoryId);
    if (idx === undefined) continue;             // reached memory is not in the candidate pool
    const score = reachedScore.get(ent.id) ?? 0;
    if (score <= 0) continue;
    graphScore.set(idx, Math.max(graphScore.get(idx) ?? 0, score));
  }
}

/**
 * Produce the graph-retrieval ranked list: `entries[]` indices ordered by graph
 * proximity (desc) to the lexical `seeds`. Only graph-reached, in-pool, non-seed
 * indices appear; the rest are absent (-> rrfFuse absentRank). Pure reads.
 *
 * Returns `[]` when there are no seeds/entries, the graph is empty, no seed maps to an
 * entity, or nothing reached is in-pool — the caller then skips the 3rd fusion list.
 */
export function graphRankStream(
  entries: ReadonlyArray<MemoryEntry>,
  seeds: ReadonlyArray<GraphSeed>,
  opts: GraphStreamOpts,
): number[] {
  if (seeds.length === 0 || entries.length === 0) return [];
  const hops = Math.min(Math.max(opts.hops ?? DEFAULT_GRAPH_HOPS, 1), MAX_HOPS);
  const decay = opts.decay ?? DEFAULT_GRAPH_DECAY;
  const maxNeighbors = opts.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;

  const memIdToIndex = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) memIdToIndex.set(entries[i].id, i);

  const graphScore = new Map<number, number>();
  const roots = opts.globalRoot && opts.globalRoot !== opts.hippoRoot
    ? [opts.hippoRoot, opts.globalRoot]
    : [opts.hippoRoot];
  for (const root of roots) {
    accumulateForRoot(
      root, seeds, entries, memIdToIndex, graphScore, hops, decay, maxNeighbors, opts.tenantId,
    );
  }

  // Seed-exclusion guard (plan-eng-critic MED): graphScore is keyed by entryIndex
  // GLOBALLY across roots, but each root's BFS visited-set is per-root, so a memory that
  // is a seed in one store could be reached as a neighbour in the other store and pick up
  // a score via max(). Drop every seed index so the "seeds are never scored by the graph
  // stream" invariant holds across roots, not just within a single store's traversal.
  for (const s of seeds) graphScore.delete(s.index);

  if (graphScore.size === 0) return [];
  return [...graphScore.keys()].sort((a, b) => {
    const d = (graphScore.get(b) ?? 0) - (graphScore.get(a) ?? 0);
    return d !== 0 ? d : a - b; // score desc, then index asc (deterministic)
  });
}
