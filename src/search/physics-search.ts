import { calculateStrength, type MemoryEntry } from '../core/memory.js';
import { estimateTokens } from '../util/token-text.js';
import { evalNow, isRecallBoostAblated } from '../core/ablation.js';
import { indexNeedsRebuild } from '../store/embeddings/index.js';
import { indexedModel } from '../store/vector-index.js';
import { resolveEmbeddingProvider } from '../store/embeddings/provider.js';
import { physicsScore as computePhysicsScores, computeMass, type PhysicsParticle } from '../core/physics.js';
import { DEFAULT_PHYSICS_CONFIG, type PhysicsConfig } from '../core/physics-config.js';
import { rethrowIfSqliteBlocked } from '../db/index.js';
import { compareScoredResults } from '../core/compare.js';
import { errorMessage, log } from '../util/log.js';
import { sqliteStore, type HippoStore, type VectorReads } from '../store/index.js';
import { churnStaleFactor, summaryMultipliers, summaryScoring, type SummaryScoring } from './boosts.js';
import { addDagFields, ageInDays } from './breakdown.js';
import { fitBudget } from './finalize.js';
import { hybridSearch } from './hybrid.js';
import { currentEntries } from './as-of.js';
import { embedQueryBy, requireVectorReads, startQueryEmbedDeadline, vectorCandidatesOutside, type HybridVectorCandidates } from './vector.js';
import { DEFAULT_RECALL_BUDGET, type ResultCost, type ScoreBreakdown, type SearchResult } from '../core/search-types.js';

export interface PhysicsSearchOptions {
  budget?: number;
  now?: Date;
  hippoRoot?: string;
  physicsConfig?: PhysicsConfig;
  queryEmbedding?: number[]; // pre-computed query vector (for testing/benchmarks)
  explain?: boolean;
  minResults?: number;
  cost?: ResultCost;
  /** Active scope for scope-boost scoring. Auto-detected if not provided. */
  scope?: string | null;
  /** Include superseded memories; must reach the inner hybrid filter or `recall --include-superseded` rows drop out here. */
  includeSuperseded?: boolean;
  /** Bi-temporal filter: memories current at this ISO date string, ranked by hybridSearch. */
  asOf?: string;
  /** Same summary deboost as hybridSearch, which also inherits it on every fallback. */
  summaryDeboost?: number;
  /** Same freshness boost as hybridSearch. */
  summaryFreshness?: boolean;
  /** Same as hybridSearch's: rows nearest the query join the pool before physics scoring. */
  vectorCandidates?: HybridVectorCandidates;
  /** Where vectors and particles are read; hippo.db under `hippoRoot` when unset. */
  store?: HippoStore;
}

interface PhysicsPools {
  entries: MemoryEntry[];
  particles: PhysicsParticle[];
  classic: MemoryEntry[];
}

interface PhysicsScoring {
  now: Date;
  explain: boolean;
  summary: SummaryScoring;
}

/** Scores memories by gravity, momentum and cluster amplification; rows without physics state rank through hybridSearch. */
export async function physicsSearch(query: string, entries: MemoryEntry[], options: PhysicsSearchOptions = {}): Promise<SearchResult[]> {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const explain = options.explain ?? false;
  const scoring: PhysicsScoring = { now, explain, summary: summaryScoring(options) };
  if (entries.length === 0 || !options.hippoRoot) return [];
  // memory_physics keeps only current positions and masses, so a past-dated query must rank without them.
  if (options.asOf) return hybridSearch(query, entries, options);
  const root = options.hippoRoot;
  const store = options.store ?? sqliteStore(root);

  // Shared with every hybrid ranking below, so a provider that stalls here is not waited on a second time.
  const queryEmbedDeadline = startQueryEmbedDeadline();
  const queryVector = await physicsQueryVector(query, root, store, queryEmbedDeadline, options.queryEmbedding);
  if (!queryVector) return hybridSearch(query, entries, { ...options, queryEmbedDeadline });
  // Checked here too, since a caller's own query vector skips the check inside physicsQueryVector.
  const reads = requireVectorReads(store);
  const pool = currentEntries(await withVectorCandidates(reads, entries, queryVector, options.vectorCandidates), options);
  const physicsMap = await loadCandidateParticles(reads, pool);
  if (!physicsMap) return hybridSearch(query, pool, { ...options, queryEmbedDeadline });

  const pools = splitByParticle(pool, physicsMap, queryVector, now);
  const config = options.physicsConfig ?? DEFAULT_PHYSICS_CONFIG;
  const physicsResults = scorePhysicsPool(pools, queryVector, config, scoring);
  const classicResults = pools.classic.length > 0
    ? await hybridSearch(query, pools.classic, { ...options, queryEmbedDeadline, vectorCandidates: undefined, budget: Infinity, explain })
    : [];
  const merged = mergeScorePools(physicsResults, classicResults);
  merged.sort(compareScoredResults);
  return fitBudget(merged, options.budget ?? DEFAULT_RECALL_BUDGET, options.minResults ?? 1, options.cost);
}

/** The caller's vector, else the provider's; null sends the caller to hybridSearch. */
async function physicsQueryVector(
  query: string, root: string, store: HippoStore, deadline: AbortSignal, given: number[] | undefined,
): Promise<number[] | null> {
  if (given && given.length > 0) return given;
  // Physics scores against particle positions, not the stored vector index, so a pruned index must not block it.
  try {
    const provider = resolveEmbeddingProvider(root);
    if (!provider.isAvailable()) return null;
    if (indexNeedsRebuild(indexedModel(await requireVectorReads(store).embeddingIndexState()), provider.id)) return null;
    const vec = await embedQueryBy(deadline, provider, query);
    return vec && vec.length > 0 ? vec : null;
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.debug(`physics search: query embed failed, using hybrid: ${errorMessage(err)}`);
    return null;
  }
}

async function withVectorCandidates(
  reads: VectorReads, entries: MemoryEntry[], queryVector: number[], spec: HybridVectorCandidates | undefined,
): Promise<MemoryEntry[]> {
  if (!spec) return entries;
  try {
    return [...entries, ...await vectorCandidatesOutside(reads, entries, queryVector, spec)];
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.warn(`physics search ranked the lexical pool only; the vector lookup failed: ${errorMessage(err)}`);
    return entries;
  }
}

/** Particles for the candidate rows only, so one tenant's search never reads every tenant's physics state. */
async function loadCandidateParticles(reads: VectorReads, pool: MemoryEntry[]): Promise<Map<string, PhysicsParticle> | null> {
  try {
    return await reads.physicsParticles(pool.map((e) => e.id));
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.debug(`physics search: state load failed, using hybrid: ${errorMessage(err)}`);
    return null;
  }
}

function splitByParticle(
  pool: MemoryEntry[], physicsMap: Map<string, PhysicsParticle>, queryVector: number[], now: Date,
): PhysicsPools {
  const pools: PhysicsPools = { entries: [], particles: [], classic: [] };
  for (const entry of pool) {
    const particle = physicsMap.get(entry.id);
    const usable = particle
      && particle.position.length > 0
      && particle.position.length === queryVector.length
      && particle.velocity.length === queryVector.length;
    if (!usable) {
      pools.classic.push(entry);
      continue;
    }
    pools.entries.push(entry);
    // EVAL-ONLY ablation (see ablation.ts): persisted masses bake in recall history twice, so the flag recomputes mass live.
    pools.particles.push(
      isRecallBoostAblated() ? { ...particle, mass: computeMass(calculateStrength(entry, now), entry.retrieval_count) } : particle,
    );
  }
  return pools;
}

function scorePhysicsPool(pools: PhysicsPools, queryVector: number[], config: PhysicsConfig, scoring: PhysicsScoring): SearchResult[] {
  if (pools.particles.length === 0) return [];
  const entryMap = new Map(pools.entries.map((e) => [e.id, e]));
  // Content tie key: baseScore ties pick the cluster amplification set, so the order must hold across fresh ingests.
  const scored = computePhysicsScores(pools.particles, queryVector, config, (id) => entryMap.get(id)?.content ?? id);
  const results: SearchResult[] = [];
  for (const s of scored) {
    if (s.finalScore <= 0) continue;
    const entry = entryMap.get(s.memoryId);
    if (!entry) continue;
    const summary = summaryMultipliers(entry, scoring.now, scoring.summary);
    const churnStaleMultiplier = churnStaleFactor(entry);
    const finalScore = s.finalScore * summary.deboost * summary.freshness * churnStaleMultiplier;
    if (finalScore <= 0) continue;
    const result: SearchResult = { entry, score: finalScore, bm25: 0, cosine: s.baseScore, tokens: estimateTokens(entry.content) };
    if (scoring.explain) {
      result.breakdown = addDagFields(
        physicsBreakdown(entry, s.baseScore, finalScore, churnStaleMultiplier, scoring.now), entry, summary.deboost, summary.freshness,
      );
    }
    results.push(result);
  }
  return results;
}

function physicsBreakdown(entry: MemoryEntry, baseScore: number, final: number, churnStaleMultiplier: number, now: Date): ScoreBreakdown {
  return {
    mode: 'physics',
    normBm25: 0,
    bm25Weight: 0,
    embeddingWeight: 1,
    cosine: baseScore,
    base: baseScore,
    strengthMultiplier: 1,
    recencyMultiplier: 1,
    decisionBoost: 1,
    pathBoost: 1,
    scopeBoost: 1,
    sourceBump: 1,
    outcomeBoost: 1,
    churnStaleMultiplier,
    matchedTerms: [],
    final,
    ageDays: ageInDays(entry, now),
  };
}

/** Normalizes each pool to [0, 1] by its largest pre-churn score, then concatenates them. */
function mergeScorePools(poolA: SearchResult[], poolB: SearchResult[]): SearchResult[] {
  const unpenalised = (r: SearchResult): number => r.score / churnStaleFactor(r.entry);
  const maxA = poolA.reduce((m, r) => Math.max(m, unpenalised(r)), 1e-9);
  const maxB = poolB.reduce((m, r) => Math.max(m, unpenalised(r)), 1e-9);
  return [...poolA.map((r) => ({ ...r, score: r.score / maxA })), ...poolB.map((r) => ({ ...r, score: r.score / maxB }))];
}
