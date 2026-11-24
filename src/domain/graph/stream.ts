import type { MemoryEntry } from '../../base/memory/entry.js';
import type { Entity, Relation } from '../../base/ports/store/graph.js';
import type { StoreGroups } from '../../base/ports/store.js';
import { MAX_HOPS, DEFAULT_MAX_NEIGHBORS } from './recall.js';
import { DEFAULT_GRAPH_HOPS } from '../../base/rank/recall-defaults.js';

/** Default per-hop multiplicative decay applied to the seed strength. */
export const DEFAULT_GRAPH_DECAY = 0.5;
/** Recommended RRF weight for the graph stream, a CLI-only convenience default. The library `graphStream.weight` option
 *  stays REQUIRED (opt-in is explicit). */
export const DEFAULT_GRAPH_STREAM_WEIGHT = 0.5;

/** A lexical seed to expand the graph from: a candidate index + its lexical strength. */
export interface GraphSeed {
  index: number;
  strength: number;
}

type GraphStore = Pick<StoreGroups, 'graphReads'>;

export interface GraphRankStreamOptions {
  store: GraphStore;
  tenantId: string;
  global?: GraphStore;
  hops?: number;
  decay?: number;
  maxNeighbors?: number;
}

/**
 * Pick the top `seedCount` candidates by best lexical rank (lowest position across BM25 and dense),
 * strength = 1/(bestRank + 1). Pure.
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
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .slice(0, seedCount)
    .map(([index, best]) => ({ index, strength: 1 / (best + 1) }));
}

interface BestStrengthAtDepthOptions {
  readonly rels: ReadonlyArray<Relation>;
  readonly frontierSet: ReadonlySet<number>;
  readonly visited: ReadonlySet<number>;
  readonly frontierStrength: ReadonlyMap<number, number>;
  readonly originStrength: ReadonlyMap<number, number>;
}

function bestStrengthAtDepth({
  rels,
  frontierSet,
  visited,
  frontierStrength,
  originStrength,
}: BestStrengthAtDepthOptions): Map<number, number> {
  const bestStrengthThisDepth = new Map<number, number>();
  for (const rel of rels) {
    const fromIn = frontierSet.has(rel.fromEntityId);
    const toIn = frontierSet.has(rel.toEntityId);
    let neighborId: number;
    let reacherId: number;
    if (fromIn && !toIn) {
      neighborId = rel.toEntityId;
      reacherId = rel.fromEntityId;
    } else if (toIn && !fromIn) {
      neighborId = rel.fromEntityId;
      reacherId = rel.toEntityId;
    } else continue;
    if (visited.has(neighborId)) continue;
    const seedStrength = frontierStrength.get(reacherId) ?? originStrength.get(reacherId) ?? 0;
    bestStrengthThisDepth.set(
      neighborId,
      Math.max(bestStrengthThisDepth.get(neighborId) ?? 0, seedStrength),
    );
  }
  return bestStrengthThisDepth;
}

interface ReachedEntityScoresOptions {
  readonly tenantId: string;
  readonly seedIds: number[];
  readonly originStrength: ReadonlyMap<number, number>;
  readonly hops: number;
  readonly decay: number;
  readonly maxNeighbors: number;
}

async function reachedEntityScores(
  store: GraphStore,
  options: ReachedEntityScoresOptions,
): Promise<Map<number, number>> {
  const { tenantId, seedIds, originStrength, hops, decay, maxNeighbors } = options;
  const visited = new Set<number>(seedIds);
  const reachedScore = new Map<number, number>();
  let frontier: number[] = seedIds;
  let frontierStrength = new Map<number, number>(originStrength);

  for (let depth = 1; depth <= hops && frontier.length > 0; depth++) {
    const frontierSet = new Set(frontier);
    const limit = Math.max(maxNeighbors, maxNeighbors * frontier.length);
    const { relations: rels } = await store.graphReads.graphRows(tenantId, {
      by: 'neighbor',
      ids: frontier,
      limit,
    });
    const bestStrengthThisDepth = bestStrengthAtDepth({
      rels,
      frontierSet,
      visited,
      frontierStrength,
      originStrength,
    });
    const next = commitStrongest(bestStrengthThisDepth, {
      visited,
      reachedScore,
      hopFactor: Math.pow(decay, depth),
      maxNeighbors,
    });
    frontier = next.frontier;
    frontierStrength = next.strength;
  }
  return reachedScore;
}

interface CommitStrongestOptions {
  readonly visited: Set<number>;
  readonly reachedScore: Map<number, number>;
  readonly hopFactor: number;
  readonly maxNeighbors: number;
}

interface NextFrontier {
  readonly frontier: number[];
  readonly strength: Map<number, number>;
}

function commitStrongest(
  bestStrengthThisDepth: ReadonlyMap<number, number>,
  options: CommitStrongestOptions,
): NextFrontier {
  const { visited, reachedScore, hopFactor, maxNeighbors } = options;
  const nextFrontier: number[] = [];
  const nextStrength = new Map<number, number>();
  const ordered = [...bestStrengthThisDepth.keys()].sort((a, b) => {
    const d = bestStrengthThisDepth.get(b)! - bestStrengthThisDepth.get(a)!;
    return d !== 0 ? d : a - b;
  });
  for (const neighborId of ordered) {
    if (nextFrontier.length >= maxNeighbors) break;
    const seedStrength = bestStrengthThisDepth.get(neighborId)!;
    visited.add(neighborId);
    reachedScore.set(
      neighborId,
      Math.max(reachedScore.get(neighborId) ?? 0, seedStrength * hopFactor),
    );
    nextStrength.set(neighborId, seedStrength);
    nextFrontier.push(neighborId);
  }
  return { frontier: nextFrontier, strength: nextStrength };
}

interface AccumulateForStoreOptions {
  readonly memIdToIndex: ReadonlyMap<string, number>;
  readonly graphScore: Map<number, number>;
  readonly hops: number;
  readonly decay: number;
  readonly maxNeighbors: number;
  readonly tenantId: string;
}

async function accumulateForStore(
  store: GraphStore,
  seeds: ReadonlyArray<GraphSeed>,
  entries: ReadonlyArray<MemoryEntry>,
  options: AccumulateForStoreOptions,
): Promise<void> {
  const { hops, decay, maxNeighbors, tenantId } = options;
  if (seeds.length === 0) return;
  const strengthByMemId = strongestSeedByMemId(seeds, entries);
  const seedIds = [...strengthByMemId.keys()];
  const { entities: seedEntities } = await store.graphReads.graphRows(tenantId, {
    by: 'memory',
    ids: seedIds,
  });
  if (seedEntities.length === 0) return;

  const originStrength = originStrengthOf(seedEntities, strengthByMemId);

  const reachedScore = await reachedEntityScores(store, {
    tenantId,
    seedIds: seedEntities.map((e) => e.id),
    originStrength,
    hops,
    decay,
    maxNeighbors,
  });
  if (reachedScore.size === 0) return;

  const reachedIds = [...reachedScore.keys()];
  const { entities: reachedEntities } = await store.graphReads.graphRows(tenantId, {
    by: 'entity',
    ids: reachedIds,
  });
  addPoolScores(reachedEntities, reachedScore, options);
}

function strongestSeedByMemId(
  seeds: ReadonlyArray<GraphSeed>,
  entries: ReadonlyArray<MemoryEntry>,
): Map<string, number> {
  const strengthByMemId = new Map<string, number>();
  for (const s of seeds) {
    const memId = entries[s.index].id;
    strengthByMemId.set(memId, Math.max(strengthByMemId.get(memId) ?? 0, s.strength));
  }
  return strengthByMemId;
}

function originStrengthOf(
  seedEntities: readonly Entity[],
  strengthByMemId: ReadonlyMap<string, number>,
): Map<number, number> {
  const originStrength = new Map<number, number>();
  for (const e of seedEntities) {
    if (e.memoryId === null) continue;
    const st = strengthByMemId.get(e.memoryId) ?? 0;
    originStrength.set(e.id, Math.max(originStrength.get(e.id) ?? 0, st));
  }
  return originStrength;
}

function addPoolScores(
  reachedEntities: readonly Entity[],
  reachedScore: ReadonlyMap<number, number>,
  options: Pick<AccumulateForStoreOptions, 'memIdToIndex' | 'graphScore'>,
): void {
  const { memIdToIndex, graphScore } = options;
  for (const ent of reachedEntities) {
    if (ent.memoryId === null) continue;
    const idx = memIdToIndex.get(ent.memoryId);
    if (idx === undefined) continue;
    const score = reachedScore.get(ent.id) ?? 0;
    if (score <= 0) continue;
    graphScore.set(idx, Math.max(graphScore.get(idx) ?? 0, score));
  }
}

/**
 * Produce the graph-retrieval ranked list: `entries[]` indices by graph proximity (desc) to the
 * lexical `seeds`; absent indices fall to rrfFuse absentRank. Returns `[]` when there are no
 * seeds/entries, the graph is empty, or nothing reached is in-pool, so the caller skips the 3rd
 * fusion list.
 */
export async function graphRankStream(
  entries: ReadonlyArray<MemoryEntry>,
  seeds: ReadonlyArray<GraphSeed>,
  opts: GraphRankStreamOptions,
): Promise<number[]> {
  if (seeds.length === 0 || entries.length === 0) return [];
  const hops = Math.min(Math.max(opts.hops ?? DEFAULT_GRAPH_HOPS, 1), MAX_HOPS);
  const decay = opts.decay ?? DEFAULT_GRAPH_DECAY;
  const maxNeighbors = opts.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;

  const memIdToIndex = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) memIdToIndex.set(entries[i].id, i);

  const graphScore = new Map<number, number>();
  const stores =
    opts.global && opts.global.graphReads !== opts.store.graphReads
      ? [opts.store, opts.global]
      : [opts.store];
  for (const store of stores) {
    await accumulateForStore(store, seeds, entries, {
      memIdToIndex,
      graphScore,
      hops,
      decay,
      maxNeighbors,
      tenantId: opts.tenantId,
    });
  }

  for (const s of seeds) graphScore.delete(s.index);

  if (graphScore.size === 0) return [];
  return [...graphScore.keys()].sort((a, b) => {
    const d = (graphScore.get(b) ?? 0) - (graphScore.get(a) ?? 0);
    return d !== 0 ? d : a - b;
  });
}
