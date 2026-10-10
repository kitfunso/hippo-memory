/** Multi-hop graph recall: a READ-ONLY walk of the relations graph from the lexical seeds, surfacing reached entities' memories the lexical search missed.
 *  Reached rows load by id (not intersected with the lexically prefiltered candidates), then the recall hard filters are re-applied.
 *  Hits inherit their seed's score minus a per-hop discount; both stores are expanded; no writes, so check-graph-writes permits it outside graph.ts. */
import { loadEntriesByIds } from '../store/entry-reads.js';
import type { MemoryEntry } from '../core/memory.js';
import { DEFAULT_RECALL_BUDGET, type ResultCost, type SearchResult } from '../core/search-types.js';
import { estimateTokens } from '../util/token-text.js';
import { compareEntryIdentity, compareScoresDesc } from '../core/compare.js';
import { loadEntitiesByMemoryId, loadEntitiesByIds, loadNeighborRelations } from '../store/graph-reads.js';
import type { Entity } from '../store/graph-rows.js';
import { passesCliRecallScopeFilter, passesScopeFilterForRecall } from '../store/recall-scope.js';

/** Hard cap on `--hops` (a higher value just walks more of a finite graph; this bounds
 *  worst-case work and keeps the flag honest). */
export const MAX_HOPS = 3;
/** Default per-hop fanout cap (bounds blow-up on a future dense graph). */
export const DEFAULT_MAX_NEIGHBORS = 25;
/** Per-hop relevance discount: a graph hit inherits its origin seed's score, scaled down
 *  1% per hop, so it ranks just below its seed and orders by hop-distance. */
const HOP_DISCOUNT = 0.01;
/** loadEntriesByIds caps each call at 500 ids; chunk to lose none on high fanout. */
const LOAD_CHUNK = 500;

type GraphVia = { hops: number; relType: string; direction: 'from' | 'to' };
type GraphHit = SearchResult & { graphVia: GraphVia };

export interface GraphExpandOpts {
  /** Hops to expand. <= 0 is a no-op (caller should not invoke, but guarded anyway). */
  hops: number;
  /** Per-hop fanout cap. Defaults to DEFAULT_MAX_NEIGHBORS. */
  maxNeighbors?: number;
  /** The local store root (where local seeds' graph lives). */
  hippoRoot: string;
  /** The global store root, when distinct + initialized (where global seeds' graph lives).
   *  A global seed is only expanded if this is provided. */
  globalRoot?: string;
  tenantId: string;
  /** Mirror the recall handler's hard filters when re-loading graph-reached rows. */
  includeSuperseded?: boolean;
  /** ISO date; bi-temporal as-of filter applied to graph-reached rows, matching cmdRecall:
   *  visible if valid_from <= asOf and, when superseded, its successor was not yet valid at asOf. */
  asOf?: string;
  /** Token budget for the augmented set (defaults to DEFAULT_RECALL_BUDGET, matching recall). */
  budget?: number;
  /** Budget cost per result; defaults to the memory text. */
  cost?: ResultCost;
  /** The recall --min-results floor: this many top base rows are kept regardless of
   *  budget, so graph expansion never violates the floor. Defaults to 1. */
  minResults?: number;
  /** Recall-side scope rule applied to graph-REACHED memories only (base results already passed the caller), mirroring HybridSearchOptions.recallScope.
   *  Omitted = default-deny (private and quarantine excluded, NULL passes), the fail-closed default for SDK callers.
   *  { requested, additive: true } is CLI --scope unlock (passesCliRecallScopeFilter); otherwise exact narrowing (passesScopeFilterForRecall). */
  recallScope?: { requested?: string; additive?: boolean; ownScope?: string };
}

/** Load memories by id in <=500-id chunks (loadEntriesByIds caps each call at 500). */
function loadByIdsChunked(root: string, tenantId: string, ids: string[]): MemoryEntry[] {
  if (ids.length === 0) return [];
  const out: MemoryEntry[] = [];
  for (let i = 0; i < ids.length; i += LOAD_CHUNK) {
    out.push(...loadEntriesByIds(root, ids.slice(i, i + LOAD_CHUNK), tenantId));
  }
  return out;
}

type HitOpts = Required<Pick<GraphExpandOpts, 'hops' | 'maxNeighbors' | 'tenantId' | 'includeSuperseded'>> & {
  asOfDate: Date | null;
  recallScope: { requested?: string; additive?: boolean; ownScope?: string };
};

interface RelationWalk {
  reached: Map<number, GraphVia>;
  originMemByEntityId: Map<number, string | null>;
}

/** BFS, both directions, up to `hops`: each reached entity's via, and the base memory it descends from. */
function walkRelations(
  root: string,
  tenantId: string,
  seedEntities: readonly Entity[],
  hops: number,
  maxNeighbors: number,
): RelationWalk {
  // `visited` makes expansion cycle-safe; `originMemByEntityId` carries each node's base-result memory id for adjacency placement and score inheritance.
  const visitedEntityIds = new Set<number>(seedEntities.map((e) => e.id));
  const reached = new Map<number, GraphVia>();
  // A seed/reached entity whose mirror was forgotten or pruned has a null memoryId; traversal still propagates origin and the null is dropped before any load.
  const originMemByEntityId = new Map<number, string | null>();
  for (const se of seedEntities) originMemByEntityId.set(se.id, se.memoryId);
  let frontier: number[] = seedEntities.map((e) => e.id);

  for (let depth = 1; depth <= hops && frontier.length > 0; depth++) {
    const frontierSet = new Set(frontier);
    const rels = loadNeighborRelations(root, tenantId, frontier, {
      limit: Math.max(maxNeighbors, maxNeighbors * frontier.length),
    });
    const nextFrontier: number[] = [];
    for (const rel of rels) {
      const fromIn = frontierSet.has(rel.fromEntityId);
      const toIn = frontierSet.has(rel.toEntityId);
      let neighborId: number;
      let reacherId: number;
      let direction: 'from' | 'to';
      if (fromIn && !toIn) { neighborId = rel.toEntityId; reacherId = rel.fromEntityId; direction = 'to'; }
      else if (toIn && !fromIn) { neighborId = rel.fromEntityId; reacherId = rel.toEntityId; direction = 'from'; }
      else continue;
      if (visitedEntityIds.has(neighborId)) continue;
      visitedEntityIds.add(neighborId);
      reached.set(neighborId, { hops: depth, relType: rel.relType, direction });
      const origin = originMemByEntityId.get(reacherId);
      if (origin !== undefined) originMemByEntityId.set(neighborId, origin);
      nextFrontier.push(neighborId);
      if (nextFrontier.length >= maxNeighbors) break; // per-hop fanout cap
    }
    frontier = nextFrontier;
  }
  return { reached, originMemByEntityId };
}

/** The recall hard filters (as-of, superseded, scope) re-applied to a directly loaded graph-reached row. */
function passesRecallFilters(mem: MemoryEntry, via: GraphVia, successorValidFrom: Map<string, string>, opts: HitOpts): boolean {
  const { includeSuperseded, asOfDate, recallScope } = opts;
  // The `to` endpoint of a `supersedes` edge IS the superseded version; the graph is authoritative because `hippo decide` does not set `superseded_by`.
  // Drop it unless --include-superseded; the newer `from` endpoint is always kept.
  const isSupersededEndpoint = via.relType === 'supersedes' && via.direction === 'to';
  if (asOfDate) {
    if (new Date(mem.valid_from) > asOfDate) return false;        // not yet valid at asOf
    if (mem.superseded_by) {
      const succVf = successorValidFrom.get(mem.superseded_by);
      // Visible only while its successor was NOT yet valid at asOf (matches cmdRecall).
      if (succVf && new Date(succVf) <= asOfDate) return false;
    }
  } else if (!includeSuperseded && (mem.superseded_by || isSupersededEndpoint)) {
    return false;                                                 // default recall drops superseded
  }
  return recallScope.additive
    ? passesCliRecallScopeFilter(mem.scope ?? null, recallScope.requested) || passesScopeFilterForRecall(mem.scope ?? null, undefined, recallScope.ownScope)
    : passesScopeFilterForRecall(mem.scope ?? null, recallScope.requested, recallScope.ownScope);
}

interface HitAccumulators {
  readonly baseScoreByMemId: Map<string, number>;
  readonly seenMemoryIds: Set<string>;
  readonly seenContent: Set<string>;
  readonly hitsByOrigin: Map<string, GraphHit[]>;
}

/** Traverse one store's graph from its seeds into `hitsByOrigin`. Pure reads; mutates `seenMemoryIds`
 *  and `seenContent` so a memory, or a share/promote copy of it, surfaces at most once across stores. */
function produceHitsForRoot(
  root: string,
  baseResults: SearchResult[],
  accumulators: HitAccumulators,
  opts: HitOpts,
): void {
  const { baseScoreByMemId, seenMemoryIds, seenContent, hitsByOrigin } = accumulators;
  const { hops, maxNeighbors, tenantId, asOfDate } = opts;

  // Seeds = graph entities (in THIS store) whose source memory is a base result.
  const seedEntities = loadEntitiesByMemoryId(root, tenantId, baseResults.map((r) => r.entry.id));
  if (seedEntities.length === 0) return;

  const { reached, originMemByEntityId } = walkRelations(root, tenantId, seedEntities, hops, maxNeighbors);
  if (reached.size === 0) return;

  const reachedEntities = loadEntitiesByIds(root, tenantId, [...reached.keys()]);
  const loadedById = loadReachedMemories(root, tenantId, reachedEntities, seenMemoryIds);
  const successorValidFrom = loadSuccessorValidFrom(root, tenantId, loadedById, asOfDate);

  for (const ent of reachedEntities) {
    if (ent.memoryId === null) continue;      // mirror-less node: not recall-surfaced
    const mem = loadedById.get(ent.memoryId);
    if (!mem) continue;                       // not found / wrong tenant / already in base
    if (seenMemoryIds.has(mem.id)) continue;  // another reached entity already added it
    if (seenContent.has(mem.content)) continue; // share/promote copy: same text, another id
    const via = reached.get(ent.id)!;
    if (!passesRecallFilters(mem, via, successorValidFrom, opts)) continue;
    const origin = originMemByEntityId.get(ent.id) ?? baseResults[0].entry.id;
    const originScore = baseScoreByMemId.get(origin) ?? baseResults[baseResults.length - 1].score;
    seenMemoryIds.add(mem.id);
    seenContent.add(mem.content);
    const hit = buildGraphHit(mem, via, originScore);
    if (!hitsByOrigin.has(origin)) hitsByOrigin.set(origin, []);
    hitsByOrigin.get(origin)!.push(hit);
  }
}

function buildGraphHit(mem: MemoryEntry, via: GraphVia, originScore: number): GraphHit {
  return {
    entry: mem,
    score: originScore * (1 - HOP_DISCOUNT * via.hops),
    bm25: 0, cosine: 0,
    tokens: estimateTokens(mem.content),
    graphVia: via,
  };
}

// Reached entities -> source memory ids -> load by id (chunked). A mirror-less entity (memoryId === null) has no memory to surface,
// so drop its null id before it reaches loadByIdsChunked.
function loadReachedMemories(
  root: string,
  tenantId: string,
  reachedEntities: ReturnType<typeof loadEntitiesByIds>,
  seenMemoryIds: Set<string>,
): Map<string, MemoryEntry> {
  const needLoad = [...new Set(
    reachedEntities
      .map((e) => e.memoryId)
      .filter((id): id is string => id !== null && !seenMemoryIds.has(id)),
  )];
  return new Map(loadByIdsChunked(root, tenantId, needLoad).map((m) => [m.id, m]));
}

// For the bi-temporal as-of rule on a superseded reached row we need its successor's
// valid_from. Batch-load the successors referenced by the loaded rows.
function loadSuccessorValidFrom(
  root: string,
  tenantId: string,
  loadedById: Map<string, MemoryEntry>,
  asOfDate: Date | null,
): Map<string, string> {
  if (!asOfDate) return new Map<string, string>();
  const succIds = [...new Set([...loadedById.values()].map((m) => m.superseded_by).filter((id): id is string => !!id))];
  return new Map(loadByIdsChunked(root, tenantId, succIds).map((m) => [m.id, m.valid_from]));
}

/** Augment `baseResults` with memories reached by walking `hops` graph edges from the seeds across local AND global stores, each placed after its seed.
 *  Returns `baseResults` unchanged when `hops <= 0`, there are no base results, or nothing new survives the filters and the token budget. */
export function graphExpandRecall(
  baseResults: SearchResult[],
  opts: GraphExpandOpts,
): SearchResult[] {
  const { hops, hippoRoot, globalRoot, tenantId } = opts;
  if (hops <= 0 || baseResults.length === 0) return baseResults;
  const maxNeighbors = opts.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;
  const includeSuperseded = opts.includeSuperseded ?? false;
  const asOfDate = opts.asOf ? new Date(opts.asOf) : null;
  const recallScope = opts.recallScope ?? {};

  const baseScoreByMemId = new Map(baseResults.map((r) => [r.entry.id, r.score]));
  const seenMemoryIds = new Set<string>(baseResults.map((r) => r.entry.id));
  const seenContent = new Set<string>(baseResults.map((r) => r.entry.content));
  const hitsByOrigin = new Map<string, GraphHit[]>();

  // Expand against each distinct store the seeds may live in (local + global).
  const roots = globalRoot && globalRoot !== hippoRoot ? [hippoRoot, globalRoot] : [hippoRoot];
  for (const root of roots) {
    produceHitsForRoot(root, baseResults, { baseScoreByMemId, seenMemoryIds, seenContent, hitsByOrigin }, {
      hops, maxNeighbors, tenantId, includeSuperseded, asOfDate, recallScope,
    });
  }

  if (hitsByOrigin.size === 0) return baseResults;
  sortHitsWithinOrigin(hitsByOrigin);
  const allHits = [...hitsByOrigin.values()].flat();
  const keep = selectWithinBudget(baseResults, allHits, opts);
  return mergeKeptHits(baseResults, hitsByOrigin, keep);
}

function sortHitsWithinOrigin(hitsByOrigin: Map<string, GraphHit[]>): void {
  // Closer hops first within each origin group, then by inherited score; compareEntryIdentity only breaks same-hop, same-score ties.
  for (const hits of hitsByOrigin.values()) {
    hits.sort((a, b) => {
      const byHops = a.graphVia.hops - b.graphVia.hops;
      if (byHops !== 0) return byHops;
      const byScore = compareScoresDesc(a.score, b.score);
      return byScore !== 0 ? byScore : compareEntryIdentity(a.entry, b.entry);
    });
  }
}

function selectWithinBudget(baseResults: SearchResult[], allHits: GraphHit[], opts: GraphExpandOpts): Set<SearchResult> {
  const budget = opts.budget ?? DEFAULT_RECALL_BUDGET;
  const minResults = opts.minResults ?? 1;
  // Budget selection is by score, not position, so a high-value graph hit can beat a low-score lexical distractor; the greedy pack uses `continue`,
  // so the DISPLAY loop emits a hit only under a kept seed. The top --min-results base rows are never evicted; at least one result is kept.
  const protectedCount = Math.min(Math.max(minResults, 1), baseResults.length);
  const keep = new Set<SearchResult>(baseResults.slice(0, protectedCount));
  const price = opts.cost ?? ((r: SearchResult) => r.tokens);
  let usedTokens = [...keep].reduce((s, r) => s + price(r), 0);
  // PLAIN stable score sort on purpose: both input lists are already deterministically
  // ordered, and a base-vs-graph-hit tie keeps the BASE result first (the concat order).
  for (const r of [...baseResults.slice(protectedCount), ...allHits].sort((a, b) => compareScoresDesc(a.score, b.score))) {
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
  // DISPLAY order: base order preserved (it may be MMR-diversified); each kept new hit
  // placed directly after the seed it descends from. Hits emit ONLY under a kept seed.
  const merged: SearchResult[] = [];
  let emittedHit = false;
  for (const r of baseResults) {
    if (!keep.has(r)) continue;
    merged.push(r);
    for (const hit of hitsByOrigin.get(r.entry.id) ?? []) {
      if (keep.has(hit)) { merged.push(hit); emittedHit = true; }
    }
  }
  return emittedHit ? merged : baseResults; // nothing new survived budget -> original base
}
