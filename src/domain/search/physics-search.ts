import {
  calculateStrength,
  strengthOptionsOf,
  type MemoryEntry,
  type StrengthOptions,
} from '../../base/memory/memory.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { evalNow } from '../../base/memory/ablation.js';
import { indexedModel, indexNeedsRebuild } from '../../base/embeddings/index-identity.js';
import { physicsScore as computePhysicsScores, computeMass, type PhysicsParticle } from '../../base/rank/physics.js';
import { DEFAULT_PHYSICS_CONFIG, type PhysicsConfig } from '../../base/rank/physics-config.js';
import type { RuntimeSettings } from '../../base/config/config.js';
import { rethrowIfStoreBlocked } from '../../base/util/store-blocked.js';
import { compareScoredResults } from '../../base/rank/compare.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import type { HippoStore, VectorReads } from '../../store/index.js';
import { churnStaleFactor, summaryMultipliers, summaryScoring, type SummaryScoring } from './boosts.js';
import { addDagFields, ageInDays } from './breakdown.js';
import { fitBudget } from './finalize.js';
import { hybridSearch } from './hybrid.js';
import { currentEntries } from './as-of.js';
import {
  embedQueryBy,
  startQueryEmbedDeadline,
  vectorCandidatesOutside,
  type HybridVectorCandidates,
  type VectorSource,
} from './vector.js';
import {
  DEFAULT_RECALL_BUDGET,
  type ResultCost,
  type ScoreBreakdown,
  type SearchResult,
} from '../../base/rank/search-types.js';

export interface PhysicsSearchOptions {
  budget?: number;
  now?: Date;
  hippoRoot?: string;
  physicsConfig?: PhysicsConfig;
  queryEmbedding?: number[]; // pre-computed query vector (for testing/benchmarks)
  explain?: boolean;
  minResults?: number;
  cost?: ResultCost;
  /** Active scope for scope-boost scoring; `runtime.activeScope` when not provided. */
  scope?: string | null;
  /** Include superseded memories; must reach the inner hybrid filter or `recall --include-superseded` rows drop out
   * here. */
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
  /** The root's environment settings, as hybridSearch takes them. */
  runtime?: RuntimeSettings;
  /** The folder whose path segments boost a memory, as hybridSearch takes it. */
  cwd?: string;
}

/** physicsSearch's options once the caller names its store; the folder fields belong to the published wrapper. */
export type PhysicsRankOptions = Omit<PhysicsSearchOptions, 'hippoRoot' | 'store'> & {
  /** Where vectors and particles are read; without one nothing ranks. */
  source?: VectorSource;
};

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

/**
 * Scores memories by gravity, momentum and cluster amplification on the store `source` names; rows without physics
 * state rank through hybridSearch.
 */
export async function physicsSearch(
  query: string,
  entries: MemoryEntry[],
  options: PhysicsRankOptions = {},
): Promise<SearchResult[]> {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const explain = options.explain ?? false;
  const scoring: PhysicsScoring = { now, explain, summary: summaryScoring(options) };
  const { source } = options;
  if (entries.length === 0 || !source) return [];
  const { store } = source;
  const hybrid = { ...options, source };
  // memory_physics keeps only current positions and masses, so a past-dated query must rank without them.
  if (options.asOf) return hybridSearch(query, entries, hybrid);

  // Shared with every hybrid ranking below, so a provider that stalls here is not waited on a second time.
  const queryEmbedDeadline = startQueryEmbedDeadline(options.runtime?.queryEmbedTimeoutMs);
  const queryVector = await physicsQueryVector(query, source, queryEmbedDeadline, options.queryEmbedding);
  if (!queryVector) return hybridSearch(query, entries, { ...hybrid, queryEmbedDeadline });
  const pool = currentEntries(
    await withVectorCandidates(store.vectors, entries, queryVector, options.vectorCandidates),
    options,
  );
  const physicsMap = await loadCandidateParticles(store.vectors, pool);
  if (!physicsMap) return hybridSearch(query, pool, { ...hybrid, queryEmbedDeadline });

  const pools = splitByParticle(pool, physicsMap, queryVector, now, strengthOptionsOf(options.runtime));
  const config = options.physicsConfig ?? DEFAULT_PHYSICS_CONFIG;
  const physicsResults = scorePhysicsPool(pools, queryVector, config, scoring);
  const classicResults =
    pools.classic.length > 0
      ? await hybridSearch(query, pools.classic, {
          ...hybrid,
          queryEmbedDeadline,
          vectorCandidates: undefined,
          budget: Infinity,
          explain,
        })
      : [];
  const merged = mergeScorePools(physicsResults, classicResults);
  merged.sort(compareScoredResults);
  return fitBudget(merged, options.budget ?? DEFAULT_RECALL_BUDGET, options.minResults ?? 1, options.cost);
}

/** The caller's vector, else the provider's; null sends the caller to hybridSearch. */
async function physicsQueryVector(
  query: string,
  source: VectorSource,
  deadline: AbortSignal,
  given: number[] | undefined,
): Promise<number[] | null> {
  if (given && given.length > 0) return given;
  // Physics scores against particle positions, not the stored vector index, so a pruned index must not block it.
  try {
    const provider = source.provider();
    if (!provider.isAvailable()) return null;
    if (indexNeedsRebuild(indexedModel(await source.store.vectors.embeddingIndexState()), provider.id)) {
      return null;
    }
    const vec = await embedQueryBy(deadline, provider, query);
    return vec && vec.length > 0 ? vec : null;
  } catch (err) {
    rethrowIfStoreBlocked(err);
    log.warn(`physics search: query embed failed, using hybrid: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
}

async function withVectorCandidates(
  reads: VectorReads,
  entries: MemoryEntry[],
  queryVector: number[],
  spec: HybridVectorCandidates | undefined,
): Promise<MemoryEntry[]> {
  if (!spec) return entries;
  try {
    return [...entries, ...(await vectorCandidatesOutside(reads, entries, queryVector, spec))];
  } catch (err) {
    rethrowIfStoreBlocked(err);
    log.warn(
      `physics search ranked the lexical pool only; the vector lookup failed: ${errorMessage(err)}`,
      errorFields(err),
    );
    return entries;
  }
}

/** Particles for the candidate rows only, so one tenant's search never reads every tenant's physics state. */
async function loadCandidateParticles(
  reads: VectorReads,
  pool: MemoryEntry[],
): Promise<Map<string, PhysicsParticle> | null> {
  try {
    return await reads.physicsParticles(pool.map((e) => e.id));
  } catch (err) {
    rethrowIfStoreBlocked(err);
    log.warn(`physics search: state load failed, using hybrid: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
}

function splitByParticle(
  pool: MemoryEntry[],
  physicsMap: Map<string, PhysicsParticle>,
  queryVector: number[],
  now: Date,
  rules: StrengthOptions,
): PhysicsPools {
  const pools: PhysicsPools = { entries: [], particles: [], classic: [] };
  const liveMass = rules.ablation?.recallBoost === true;
  for (const entry of pool) {
    const particle = physicsMap.get(entry.id);
    const usable =
      particle &&
      particle.position.length > 0 &&
      particle.position.length === queryVector.length &&
      particle.velocity.length === queryVector.length;
    if (!usable) {
      pools.classic.push(entry);
      continue;
    }
    pools.entries.push(entry);
    // EVAL-ONLY ablation (see ablation.ts): persisted masses bake in recall history twice, so the flag recomputes mass
    // live.
    pools.particles.push(
      liveMass
        ? {
            ...particle,
            mass: computeMass(calculateStrength(entry, now, rules), entry.retrievalCount, rules.ablation),
          }
        : particle,
    );
  }
  return pools;
}

function scorePhysicsPool(
  pools: PhysicsPools,
  queryVector: number[],
  config: PhysicsConfig,
  scoring: PhysicsScoring,
): SearchResult[] {
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
    const result: SearchResult = {
      entry,
      score: finalScore,
      bm25: 0,
      cosine: s.baseScore,
      tokens: estimateTokens(entry.content),
    };
    if (scoring.explain) {
      result.breakdown = addDagFields(
        physicsBreakdown(entry, s.baseScore, finalScore, churnStaleMultiplier, scoring.now),
        entry,
        summary.deboost,
        summary.freshness,
      );
    }
    results.push(result);
  }
  return results;
}

function physicsBreakdown(
  entry: MemoryEntry,
  baseScore: number,
  final: number,
  churnStaleMultiplier: number,
  now: Date,
): ScoreBreakdown {
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
  return [
    ...poolA.map((r) => ({ ...r, score: r.score / maxA })),
    ...poolB.map((r) => ({ ...r, score: r.score / maxB })),
  ];
}
