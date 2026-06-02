/**
 * E3.2 multi-hop graph recall (docs/plans/2026-06-02-e3.2-multihop-recall.md).
 *
 * READ-ONLY consumer of the E3 graph substrate (entities/relations built by E3.1,
 * guarded by E3.3). Given the lexical recall seeds, walk the relations graph up to N
 * hops and surface the memories of reached entities that the lexical search did not
 * already return.
 *
 * Relation-type-AGNOSTIC: it walks whatever edges exist. Today the graph holds only
 * `supersedes` edges (so a 1-hop walk surfaces a supersession-linked predecessor/
 * successor a lexical search may miss); the moment E3.1 emits cross-object edges
 * (owns/depends-on/blocked-by/references) the SAME traversal lights up cross-entity
 * multi-hop with zero rework here.
 *
 * Design points (the first two were forced by the verify-stage benchmark, the rest by
 * codex review — all root-cause, not patches):
 *  1. Graph-reached memories are loaded DIRECTLY by id (tenant-scoped PK fetch), NOT
 *     intersected with the recall handler's candidate set — that set is lexically
 *     prefiltered (loadSearchRows filters by query tokens), so intersecting would exclude
 *     exactly the lexically-orthogonal neighbours graph recall exists to surface. We
 *     re-apply the recall HARD filters to the directly-loaded rows: the FULL bi-temporal
 *     as-of rule (valid_from <= asOf AND, for a superseded row, successor.valid_from >
 *     asOf — same as cmdRecall) and the default superseded-drop. SCOPE is intentionally
 *     NOT re-applied: the CLI caller (cmdRecall) does not hard-filter scope either (it
 *     only soft-boosts it). Rows are tenant-scoped + archived-excluded (loadEntriesByIds).
 *  2. A graph hit inherits its origin seed's relevance (minus a per-hop discount) and is
 *     placed adjacent to that seed; budget selection is by score so a high-value hit wins
 *     a token slot over a noise distractor. Dead-last appending made the feature do
 *     nothing at realistic budgets.
 *  3. BOTH the local and global stores are expanded — a global seed's entities/relations
 *     live under the global root, so graph recall must traverse each seed in the store its
 *     graph lives in (codex review).
 *  4. By-id loads are chunked at 500 (loadEntriesByIds caps at 500/call), so a high-fanout
 *     traversal (--hops 3 --max-neighbors 200 -> up to 600 ids) loses none (codex review).
 *
 * No graph writes (only SELECTs via graph.ts read helpers + store reads), so the E3.3
 * check-graph-writes lint permits this module living outside graph.ts.
 */
import { loadEntriesByIds } from './store.js';
import type { MemoryEntry } from './memory.js';
import { type SearchResult, estimateTokens } from './search.js';
import {
  loadEntitiesByMemoryId,
  loadEntitiesByIds,
  loadNeighborRelations,
} from './graph.js';

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
  /** ISO date; bi-temporal as-of filter applied to graph-reached rows (full rule, matching
   *  cmdRecall: a row is visible if valid_from <= asOf AND, when superseded, its successor
   *  was not yet valid at asOf). */
  asOf?: string;
  /** Token budget for the augmented set (defaults to 4000, matching recall's default). */
  budget?: number;
  /** The recall --min-results floor: this many top base rows are kept regardless of
   *  budget, so graph expansion never violates the floor. Defaults to 1. */
  minResults?: number;
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

/**
 * Traverse one store's graph from the seeds present in it and accumulate new graph hits
 * into `hitsByOrigin`. Mutates `seenMemoryIds` so a memory is surfaced at most once across
 * stores. Pure reads.
 */
function produceHitsForRoot(
  root: string,
  baseResults: SearchResult[],
  baseScoreByMemId: Map<string, number>,
  seenMemoryIds: Set<string>,
  hitsByOrigin: Map<string, GraphHit[]>,
  opts: Required<Pick<GraphExpandOpts, 'hops' | 'maxNeighbors' | 'tenantId' | 'includeSuperseded'>> & { asOfDate: Date | null },
): void {
  const { hops, maxNeighbors, tenantId, includeSuperseded, asOfDate } = opts;

  // Seeds = graph entities (in THIS store) whose source memory is a base result.
  const seedEntities = loadEntitiesByMemoryId(root, tenantId, baseResults.map((r) => r.entry.id));
  if (seedEntities.length === 0) return;

  // BFS, both directions, up to `hops`. `visited` prevents re-expansion (cycle-safe).
  // `originMemByEntityId` propagates the base-result memory id each reached node descends
  // from (for adjacency placement + score inheritance).
  const visitedEntityIds = new Set<number>(seedEntities.map((e) => e.id));
  const reached = new Map<number, GraphVia>();
  const originMemByEntityId = new Map<number, string>();
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
  if (reached.size === 0) return;

  // Reached entities -> source memory ids -> load DIRECTLY by id (chunked), not lexical.
  const reachedEntities = loadEntitiesByIds(root, tenantId, [...reached.keys()]);
  const needLoad = [...new Set(reachedEntities.map((e) => e.memoryId).filter((id) => !seenMemoryIds.has(id)))];
  const loadedById = new Map(loadByIdsChunked(root, tenantId, needLoad).map((m) => [m.id, m]));

  // For the bi-temporal as-of rule on a superseded reached row we need its successor's
  // valid_from. Batch-load the successors referenced by the loaded rows.
  let successorValidFrom = new Map<string, string>();
  if (asOfDate) {
    const succIds = [...new Set([...loadedById.values()].map((m) => m.superseded_by).filter((id): id is string => !!id))];
    successorValidFrom = new Map(loadByIdsChunked(root, tenantId, succIds).map((m) => [m.id, m.valid_from]));
  }

  for (const ent of reachedEntities) {
    const mem = loadedById.get(ent.memoryId);
    if (!mem) continue;                       // not found / wrong tenant / already in base
    if (seenMemoryIds.has(mem.id)) continue;  // another reached entity already added it
    const via = reached.get(ent.id)!;
    // A node reached as the `to` endpoint of a `supersedes` edge IS the superseded
    // (older) version — the graph is the authoritative signal (the memory mirror's
    // `superseded_by` is NOT set by `hippo decide`, only the decisions table is). By
    // default recall shows current truth, so drop it unless --include-superseded; the
    // `from` endpoint (the newer successor) is always kept.
    const isSupersededEndpoint = via.relType === 'supersedes' && via.direction === 'to';
    if (asOfDate) {
      if (new Date(mem.valid_from) > asOfDate) continue;        // not yet valid at asOf
      if (mem.superseded_by) {
        const succVf = successorValidFrom.get(mem.superseded_by);
        // Visible only while its successor was NOT yet valid at asOf (matches cmdRecall).
        if (succVf && new Date(succVf) <= asOfDate) continue;
      }
    } else if (!includeSuperseded && (mem.superseded_by || isSupersededEndpoint)) {
      continue;                                                 // default recall drops superseded
    }
    const origin = originMemByEntityId.get(ent.id) ?? baseResults[0].entry.id;
    const originScore = baseScoreByMemId.get(origin) ?? baseResults[baseResults.length - 1].score;
    seenMemoryIds.add(mem.id);
    const hit: GraphHit = {
      entry: mem,
      score: originScore * (1 - HOP_DISCOUNT * via.hops),
      bm25: 0, cosine: 0,
      tokens: estimateTokens(mem.content),
      graphVia: via,
    };
    if (!hitsByOrigin.has(origin)) hitsByOrigin.set(origin, []);
    hitsByOrigin.get(origin)!.push(hit);
  }
}

/**
 * Augment `baseResults` with memories reached by walking the graph `hops` edges out from
 * the seed results' entities (across the local AND global stores). Each graph hit is
 * inserted directly after the base result it descends from, scored just below that seed;
 * the base list's own order is preserved. Token-budget-bounded; deduped against the base
 * set and across stores.
 *
 * No-op (returns `baseResults` unchanged) when `hops <= 0`, there are no base results, the
 * graph is empty, no seed maps to an entity, or nothing new survives the filters/budget.
 */
export function graphExpandRecall(
  baseResults: SearchResult[],
  opts: GraphExpandOpts,
): SearchResult[] {
  const { hops, hippoRoot, globalRoot, tenantId } = opts;
  if (hops <= 0 || baseResults.length === 0) return baseResults;
  const maxNeighbors = opts.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;
  const budget = opts.budget ?? 4000;
  const includeSuperseded = opts.includeSuperseded ?? false;
  const asOfDate = opts.asOf ? new Date(opts.asOf) : null;
  const minResults = opts.minResults ?? 1;

  const baseScoreByMemId = new Map(baseResults.map((r) => [r.entry.id, r.score]));
  const seenMemoryIds = new Set<string>(baseResults.map((r) => r.entry.id));
  const hitsByOrigin = new Map<string, GraphHit[]>();

  // Expand against each distinct store the seeds may live in (local + global).
  const roots = globalRoot && globalRoot !== hippoRoot ? [hippoRoot, globalRoot] : [hippoRoot];
  for (const root of roots) {
    produceHitsForRoot(root, baseResults, baseScoreByMemId, seenMemoryIds, hitsByOrigin, {
      hops, maxNeighbors, tenantId, includeSuperseded, asOfDate,
    });
  }

  if (hitsByOrigin.size === 0) return baseResults;
  // Closer hops first within each origin group, then by inherited score.
  for (const hits of hitsByOrigin.values()) {
    hits.sort((a, b) => a.graphVia.hops - b.graphVia.hops || b.score - a.score);
  }
  const allHits = [...hitsByOrigin.values()].flat();

  // Budget SELECTION by score (not by position): a high-value graph hit (it inherits its
  // origin seed's relevance) must be able to win a token slot over a low-score lexical
  // distractor — otherwise a tight --budget keeps the noise and drops the memory --hops
  // surfaced. The greedy pack uses `continue` (not `break`), so a hit's origin seed is
  // NOT guaranteed kept just because the hit is; the DISPLAY loop guards that (a hit is
  // emitted ONLY under a kept seed, never orphaned). At least one result is always kept.
  // (NOTE: at a tight budget a new graph hit can displace a weakly-scored base result;
  // aggregate recall stays >= baseline, the displaced item is the lowest-value one.)
  // Protect the top --min-results base rows from eviction (graph expansion must not
  // violate the recall min-results floor; codex P2). They are kept regardless of budget;
  // baseResults is score-ordered, so slice(0, N) is the top N.
  const protectedCount = Math.min(Math.max(minResults, 1), baseResults.length);
  const keep = new Set<SearchResult>(baseResults.slice(0, protectedCount));
  let usedTokens = [...keep].reduce((s, r) => s + r.tokens, 0);
  for (const r of [...baseResults.slice(protectedCount), ...allHits].sort((a, b) => b.score - a.score)) {
    if (usedTokens + r.tokens > budget) continue;
    usedTokens += r.tokens;
    keep.add(r);
  }

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
