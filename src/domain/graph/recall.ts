import type { MemoryEntry } from '../../base/memory/entry.js';
import {
  DEFAULT_MIN_RESULTS,
  DEFAULT_RECALL_BUDGET,
  type ResultCost,
  type SearchResult,
} from '../../base/rank/search-types.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { shownText } from '../../base/memory/lead-in.js';
import { identityText } from '../../base/util/same-text.js';
import { compareEntryIdentity, compareScoresDesc } from '../../base/rank/compare.js';
import type { Entity, GraphRows, Relation } from '../../base/ports/store/graph.js';
import type { RequiredStore, StoreGroups, StoreWith } from '../../base/ports/store.js';
import {
  passesCliRecallScopeFilter,
  passesScopeFilterForRecall,
} from '../../base/scope/recall-scope.js';
import { isSuperseded } from '../../base/memory/liveness.js';

/** Hard cap on `--hops` (a higher value just walks more of a finite graph; this bounds worst-case work and keeps the
 *  flag honest). */
export const MAX_HOPS = 3;
/** Default per-hop fanout cap (bounds blow-up on a future dense graph). */
export const DEFAULT_MAX_NEIGHBORS = 25;
const HOP_DISCOUNT = 0.01;
type GraphVia = { hops: number; relType: string; direction: 'from' | 'to' };
type GraphStore = Pick<StoreGroups, 'graphReads'> & Pick<RequiredStore, 'entriesByIds'>;

/** The graph a store keeps, as expansion walks it; a store that keeps none has no neighbours to
 * add. */
export function graphOf(store: StoreWith<never, 'graphReads'>): GraphStore | undefined {
  const { graphReads } = store;
  if (graphReads === undefined) return undefined;
  return { graphReads, entriesByIds: (ids, tenantId) => store.entriesByIds(ids, tenantId) };
}
type GraphHit = SearchResult & { graphVia: GraphVia };

export interface GraphExpandOptions {
  /** Hops to expand. <= 0 is a no-op (caller should not invoke, but guarded anyway). */
  hops: number;
  /** Per-hop fanout cap. Defaults to DEFAULT_MAX_NEIGHBORS. */
  maxNeighbors?: number;
  /** The local store (where local seeds' graph lives). */
  store: GraphStore;
  /** The global store, when distinct (where global seeds' graph lives).
   *  A global seed is only expanded if this is provided. */
  global?: GraphStore;
  tenantId: string;
  /** Mirror the recall handler's hard filters when re-loading graph-reached rows. */
  includeSuperseded?: boolean;
  /** ISO date; bi-temporal as-of filter applied to graph-reached rows, matching recall: visible if valid_from <=
   *  asOf and, when superseded, its successor was not yet valid at asOf. */
  asOf?: string;
  /** Token budget for the augmented set (defaults to DEFAULT_RECALL_BUDGET, matching recall). */
  budget?: number;
  /** Budget cost per result; defaults to the memory text. */
  cost?: ResultCost;
  /** The recall --min-results floor: this many top base rows are kept regardless of budget, so graph expansion never
   *  violates the floor. Defaults to 1. */
  minResults?: number;
  /**
   * Recall-side scope rule applied to graph-REACHED memories only (base results already passed the
   * caller), mirroring HybridSearchOptions.recallScope. Omitted = default-deny (private and
   * quarantine excluded, NULL passes), the fail-closed default for SDK callers. { requested,
   * additive: true } is CLI --scope unlock (passesCliRecallScopeFilter); otherwise exact narrowing
   * (passesScopeFilterForRecall).
   */
  recallScope?: { requested?: string; additive?: boolean; ownScope?: string };
}

type HitOptions = Required<
  Pick<GraphExpandOptions, 'hops' | 'maxNeighbors' | 'tenantId' | 'includeSuperseded'>
> & {
  asOfDate: Date | null;
  recallScope: { requested?: string; additive?: boolean; ownScope?: string };
  global: boolean;
};

interface RelationWalk {
  reached: Map<number, GraphVia>;
  originMemByEntityId: Map<number, string | null>;
}

interface WalkRelationsOptions {
  readonly tenantId: string;
  readonly seedEntities: readonly Entity[];
  readonly hops: number;
  readonly maxNeighbors: number;
}

async function walkRelations(
  store: GraphStore,
  { tenantId, seedEntities, hops, maxNeighbors }: WalkRelationsOptions,
): Promise<RelationWalk> {
  const visitedEntityIds = new Set<number>(seedEntities.map((e) => e.id));
  const reached = new Map<number, GraphVia>();
  const originMemByEntityId = new Map<number, string | null>();
  for (const se of seedEntities) originMemByEntityId.set(se.id, se.memoryId);
  let frontier: number[] = seedEntities.map((e) => e.id);

  for (let depth = 1; depth <= hops && frontier.length > 0; depth++) {
    const frontierSet = new Set(frontier);
    const { relations: rels } = await neighborRelations(store, tenantId, frontier, maxNeighbors);
    const nextFrontier: number[] = [];
    for (const rel of rels) {
      const step = stepAcross(rel, frontierSet);
      if (step === null) continue;
      const { neighborId, reacherId, direction } = step;
      if (visitedEntityIds.has(neighborId)) continue;
      visitedEntityIds.add(neighborId);
      reached.set(neighborId, { hops: depth, relType: rel.relType, direction });
      const origin = originMemByEntityId.get(reacherId);
      if (origin !== undefined) originMemByEntityId.set(neighborId, origin);
      nextFrontier.push(neighborId);
      if (nextFrontier.length >= maxNeighbors) break;
    }
    frontier = nextFrontier;
  }
  return { reached, originMemByEntityId };
}

function neighborRelations(
  store: GraphStore,
  tenantId: string,
  frontier: number[],
  maxNeighbors: number,
): Promise<GraphRows> {
  const limit = Math.max(maxNeighbors, maxNeighbors * frontier.length);
  return store.graphReads.graphRows(tenantId, { by: 'neighbor', ids: frontier, limit });
}

interface RelationStep {
  readonly neighborId: number;
  readonly reacherId: number;
  readonly direction: 'from' | 'to';
}

function stepAcross(rel: Relation, frontierSet: ReadonlySet<number>): RelationStep | null {
  const fromIn = frontierSet.has(rel.fromEntityId);
  const toIn = frontierSet.has(rel.toEntityId);
  if (fromIn && !toIn) {
    return { neighborId: rel.toEntityId, reacherId: rel.fromEntityId, direction: 'to' };
  }
  if (toIn && !fromIn) {
    return { neighborId: rel.fromEntityId, reacherId: rel.toEntityId, direction: 'from' };
  }
  return null;
}

function passesRecallFilters(
  mem: MemoryEntry,
  via: GraphVia,
  successorValidFrom: Map<string, string>,
  opts: HitOptions,
): boolean {
  const { includeSuperseded, asOfDate, recallScope } = opts;
  const isSupersededEndpoint = via.relType === 'supersedes' && via.direction === 'to';
  if (asOfDate) {
    if (new Date(mem.validFrom) > asOfDate) return false;
    if (isSuperseded(mem)) {
      const succVf = successorValidFrom.get(mem.supersededBy);
      if (succVf && new Date(succVf) <= asOfDate) return false;
    }
  } else if (!includeSuperseded && (isSuperseded(mem) || isSupersededEndpoint)) {
    return false;
  }
  return recallScope.additive
    ? passesCliRecallScopeFilter(mem.scope ?? null, recallScope.requested) ||
        passesScopeFilterForRecall(mem.scope ?? null, undefined, recallScope.ownScope)
    : passesScopeFilterForRecall(mem.scope ?? null, recallScope.requested, recallScope.ownScope);
}

interface HitAccumulators {
  readonly baseScoreByMemId: Map<string, number>;
  readonly seenMemoryIds: Set<string>;
  readonly seenContent: Set<string>;
  readonly hitsByOrigin: Map<string, GraphHit[]>;
}

async function produceHitsForStore(
  store: GraphStore,
  baseResults: SearchResult[],
  accumulators: HitAccumulators,
  opts: HitOptions,
): Promise<void> {
  const { baseScoreByMemId, seenMemoryIds, seenContent } = accumulators;
  const { hops, maxNeighbors, tenantId, asOfDate } = opts;

  const { entities: seedEntities } = await store.graphReads.graphRows(tenantId, {
    by: 'memory',
    ids: baseResults.map((r) => r.entry.id),
  });
  if (seedEntities.length === 0) return;

  const walk = await walkRelations(store, { tenantId, seedEntities, hops, maxNeighbors });
  if (walk.reached.size === 0) return;

  const { entities: reachedEntities } = await store.graphReads.graphRows(tenantId, {
    by: 'entity',
    ids: [...walk.reached.keys()],
  });
  const loadedById = await loadReachedMemories(store, tenantId, reachedEntities, seenMemoryIds);
  const successorValidFrom = await loadSuccessorValidFrom(store, tenantId, loadedById, asOfDate);

  for (const ent of reachedEntities) {
    if (ent.memoryId === null) continue;
    const mem = loadedById.get(ent.memoryId);
    if (!mem) continue;
    if (seenMemoryIds.has(mem.id)) continue;
    if (seenContent.has(identityText(mem))) continue;
    const via = walk.reached.get(ent.id)!;
    if (!passesRecallFilters(mem, via, successorValidFrom, opts)) continue;
    const origin = walk.originMemByEntityId.get(ent.id) ?? baseResults[0].entry.id;
    const originScore = baseScoreByMemId.get(origin) ?? baseResults[baseResults.length - 1].score;
    addHit(accumulators, origin, buildGraphHit(mem, via, originScore, opts.global));
  }
}

function addHit(accumulators: HitAccumulators, origin: string, hit: GraphHit): void {
  const { seenMemoryIds, seenContent, hitsByOrigin } = accumulators;
  seenMemoryIds.add(hit.entry.id);
  seenContent.add(identityText(hit.entry));
  if (!hitsByOrigin.has(origin)) hitsByOrigin.set(origin, []);
  hitsByOrigin.get(origin)!.push(hit);
}

function buildGraphHit(
  mem: MemoryEntry,
  via: GraphVia,
  originScore: number,
  isGlobal: boolean,
): GraphHit {
  return {
    entry: mem,
    score: originScore * (1 - HOP_DISCOUNT * via.hops),
    bm25: 0,
    cosine: 0,
    tokens: estimateTokens(shownText(mem)),
    graphVia: via,
    isGlobal,
  };
}

async function loadReachedMemories(
  store: GraphStore,
  tenantId: string,
  reachedEntities: readonly Entity[],
  seenMemoryIds: Set<string>,
): Promise<Map<string, MemoryEntry>> {
  const needLoad = [
    ...new Set(
      reachedEntities
        .map((e) => e.memoryId)
        .filter((id): id is string => id !== null && !seenMemoryIds.has(id)),
    ),
  ];
  return new Map((await store.entriesByIds(needLoad, tenantId)).map((m) => [m.id, m]));
}

async function loadSuccessorValidFrom(
  store: GraphStore,
  tenantId: string,
  loadedById: Map<string, MemoryEntry>,
  asOfDate: Date | null,
): Promise<Map<string, string>> {
  if (!asOfDate) return new Map<string, string>();
  const succIds = [
    ...new Set(
      [...loadedById.values()].map((m) => m.supersededBy).filter((id): id is string => !!id),
    ),
  ];
  return new Map((await store.entriesByIds(succIds, tenantId)).map((m) => [m.id, m.validFrom]));
}

/**
 * Augment `baseResults` with memories reached by walking `hops` graph edges from the seeds across
 * local AND global stores, each placed after its seed. Returns `baseResults` unchanged when `hops
 * <= 0`, there are no base results, or nothing new survives the filters and the token budget.
 */
export async function graphExpandRecall(
  baseResults: SearchResult[],
  opts: GraphExpandOptions,
): Promise<SearchResult[]> {
  const { hops, store, global, tenantId } = opts;
  if (hops <= 0 || baseResults.length === 0) return baseResults;
  const maxNeighbors = opts.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;
  const includeSuperseded = opts.includeSuperseded ?? false;
  const asOfDate = opts.asOf ? new Date(opts.asOf) : null;
  const recallScope = opts.recallScope ?? {};

  const baseScoreByMemId = new Map(baseResults.map((r) => [r.entry.id, r.score]));
  const seenMemoryIds = new Set<string>(baseResults.map((r) => r.entry.id));
  const seenContent = new Set<string>(baseResults.map((r) => identityText(r.entry)));
  const hitsByOrigin = new Map<string, GraphHit[]>();

  const stores = global && global.graphReads !== store.graphReads ? [store, global] : [store];
  for (const each of stores) {
    await produceHitsForStore(
      each,
      baseResults,
      { baseScoreByMemId, seenMemoryIds, seenContent, hitsByOrigin },
      {
        hops,
        maxNeighbors,
        tenantId,
        includeSuperseded,
        asOfDate,
        recallScope,
        global: each !== store,
      },
    );
  }

  if (hitsByOrigin.size === 0) return baseResults;
  sortHitsWithinOrigin(hitsByOrigin);
  const allHits = [...hitsByOrigin.values()].flat();
  const keep = selectWithinBudget(baseResults, allHits, opts);
  return mergeKeptHits(baseResults, hitsByOrigin, keep);
}

function sortHitsWithinOrigin(hitsByOrigin: Map<string, GraphHit[]>): void {
  for (const hits of hitsByOrigin.values()) {
    hits.sort((a, b) => {
      const byHops = a.graphVia.hops - b.graphVia.hops;
      if (byHops !== 0) return byHops;
      const byScore = compareScoresDesc(a.score, b.score);
      return byScore !== 0 ? byScore : compareEntryIdentity(a.entry, b.entry);
    });
  }
}

function selectWithinBudget(
  baseResults: SearchResult[],
  allHits: GraphHit[],
  opts: GraphExpandOptions,
): Set<SearchResult> {
  const budget = opts.budget ?? DEFAULT_RECALL_BUDGET;
  const minResults = opts.minResults ?? DEFAULT_MIN_RESULTS;
  const protectedCount = Math.min(Math.max(minResults, 1), baseResults.length);
  const keep = new Set<SearchResult>(baseResults.slice(0, protectedCount));
  const price = opts.cost ?? ((r: SearchResult) => r.tokens);
  let usedTokens = [...keep].reduce((s, r) => s + price(r), 0);
  for (const r of [...baseResults.slice(protectedCount), ...allHits].sort((a, b) =>
    compareScoresDesc(a.score, b.score),
  )) {
    const tokens = price(r);
    if (usedTokens + tokens > budget) continue;
    usedTokens += tokens;
    keep.add(r);
  }
  return keep;
}

function mergeKeptHits(
  baseResults: SearchResult[],
  hitsByOrigin: Map<string, GraphHit[]>,
  keep: Set<SearchResult>,
): SearchResult[] {
  const merged: SearchResult[] = [];
  let emittedHit = false;
  for (const r of baseResults) {
    if (!keep.has(r)) continue;
    merged.push(r);
    for (const hit of hitsByOrigin.get(r.entry.id) ?? []) {
      if (keep.has(hit)) {
        merged.push(hit);
        emittedHit = true;
      }
    }
  }
  return emittedHit ? merged : baseResults;
}
