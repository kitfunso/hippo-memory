import type { MemoryEntry } from '../../base/memory/entry.js';
import { cosineOf } from '../../base/rank/cosine.js';
import { indexedModel, indexNeedsRebuild } from '../../base/embeddings/index-identity.js';
import type { EmbeddingProvider } from '../../base/ports/embedder.js';
import { rethrowIfStoreBlocked } from '../../base/util/store-blocked.js';
import { errorFields, errorMessage, log, type LogFields } from '../../base/util/log.js';
import type { RuntimeSettings } from '../../base/config/config.js';
import type { VectorReads } from '../../base/ports/store-index.js';
import type { HippoStore } from '../../base/ports/store.js';
import type { GraphWalk } from '../graph/recall.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';

import { currentEntries, type CurrentnessOptions } from './as-of.js';
import type { VectorCandidateSpec } from '../../base/ports/store/vectors.js';

/**
 * rankHybrid's vector arm: which rows it may add, plus the caller's JS admission rules (exact
 * private regex, entry filters).
 */
export type HybridVectorCandidates = VectorCandidateSpec & {
  admit?: (entry: MemoryEntry) => boolean;
};

/** What the vector arm produced; fields fill in step by step, so a late failure keeps the rows
 * already added. */
export interface VectorArm {
  entries: MemoryEntry[];
  addedRows: boolean;
  useEmbeddings: boolean;
  embeddingIndex: Record<string, ArrayLike<number>>;
  queryVector: number[];
}

/** Where the vector arm reads: the vectors `store` holds, embedded by `provider`. */
export interface VectorSource {
  readonly store: HippoStore;
  readonly vectors: VectorReads;
  /** The store's graph, which the graph list walks; unset on a store that keeps none. */
  readonly graphReads?: GraphWalk;
  /** Resolved inside the arm's try, so a bad embeddings config falls back to BM25 rather than
   * failing the search. */
  readonly provider: () => EmbeddingProvider;
  /** The store is hippo.db, whose index `hippo embed` rebuilds; any other store rebuilds its
   * vectors from hippo.db. */
  readonly onHippoDb?: boolean;
}

export interface VectorArmOptions extends CurrentnessOptions {
  vectorCandidates?: HybridVectorCandidates;
  /** The deadline a caller already started for this recall's query embedding; a fresh budget
   * when unset. */
  queryEmbedDeadline?: AbortSignal;
  /** The root's settings; a fresh budget lasts its `queryEmbedTimeoutMs`. */
  runtime?: Pick<RuntimeSettings, 'queryEmbedTimeoutMs'>;
  /** The request's abort signal; a fresh budget ends with it too. */
  signal?: AbortSignal;
}

// Jev's default budget (infra/rerankers/jev.ts): each is one off-box call that a recall waits on.
const QUERY_EMBED_BUDGET_MS = 5_000;

/**
 * How long one recall waits for its query vector, retries included; the root's
 * HIPPO_QUERY_EMBED_TIMEOUT_MS overrides the default.
 */
function queryEmbedBudgetMs(configured: number | undefined): number {
  return configured ?? QUERY_EMBED_BUDGET_MS;
}

/** One deadline for every query embedding a recall makes, so two stores share the budget; the
 * request's own abort ends it as well. */
export function startQueryEmbedDeadline({
  runtime,
  signal,
}: Pick<VectorArmOptions, 'runtime' | 'signal'>): AbortSignal {
  const budget = AbortSignal.timeout(queryEmbedBudgetMs(runtime?.queryEmbedTimeoutMs));
  return signal === undefined ? budget : AbortSignal.any([budget, signal]);
}

/**
 * The query's vector, or null when the provider outlasts `deadline`: an API call, or a local model
 * still downloading. Any other failure throws.
 */
export async function embedQueryBy(
  deadline: AbortSignal,
  provider: EmbeddingProvider,
  query: string,
): Promise<number[] | null> {
  try {
    return (await provider.embed([query], 'query', { signal: deadline }))[0] ?? [];
  } catch (err) {
    if (deadline.aborted) return null;
    throw err;
  }
}

// Search runs on every hook prompt, so one line per reason per process says why vectors went unused
// without flooding stderr. A repeat still logs, at debug and then every SAMPLE_EVERY at warn, so a
// fallback that keeps happening stays visible.
function warnBm25Fallback(reason: string, detail: string, fields?: LogFields): void {
  log.warnThenSample(
    `search.bm25-fallback.${reason}`,
    `hybrid search fell back to BM25 only: ${redactSecretsStrict(detail)}`,
    fields,
  );
}

function reindexHint({ store, onHippoDb }: VectorSource): string {
  const why = 'the embedding index was built by another model or is being rebuilt';
  return onHippoDb
    ? `${why}; run 'hippo embed'`
    : `${why}; run 'hippo embed' on the folder's hippo.db, then rebuild the '${store.kind}' database from it`;
}

/** The nearest admitted rows not already in `entries`. */
export async function vectorCandidatesOutside(
  reads: VectorReads,
  entries: readonly MemoryEntry[],
  queryVector: readonly number[],
  spec: HybridVectorCandidates,
): Promise<MemoryEntry[]> {
  const inPool = new Set(entries.map((e) => e.id));
  // The port takes data alone: `admit` is this side's rule, and a function cannot be sent to a
  // store on another thread.
  const { admit, ...stored } = spec;
  return (await reads.nearestEntries(queryVector, stored)).filter(
    (e) => !inPool.has(e.id) && (admit?.(e) ?? true),
  );
}

/** Embeds the query and loads stored vectors; any failure leaves BM25 to rank alone. */
export async function resolveVectorArm(
  query: string,
  entries: MemoryEntry[],
  source: VectorSource | undefined,
  options: VectorArmOptions,
): Promise<VectorArm> {
  const arm: VectorArm = {
    entries,
    addedRows: false,
    useEmbeddings: false,
    embeddingIndex: {},
    queryVector: [],
  };
  if (!source) return arm;
  try {
    await fillVectorArm(arm, query, source, options);
  } catch (err) {
    rethrowIfStoreBlocked(err);
    warnBm25Fallback('error', errorMessage(err), errorFields(err, redactSecretsStrict));
  }
  return arm;
}

async function fillVectorArm(
  arm: VectorArm,
  query: string,
  source: VectorSource,
  options: VectorArmOptions,
): Promise<void> {
  const { vectors: reads } = source;
  const provider = source.provider();
  if (!provider.isAvailable()) return;
  const spec = options.vectorCandidates;
  const vectors = await usableVectors(arm, source, provider, spec);
  if (vectors === null) return;
  const vec = await embedWithinBudget(query, provider, options);
  if (vec === null) return;
  arm.queryVector = vec;
  if (arm.queryVector.length === 0) {
    warnBm25Fallback(
      'empty-query-vector',
      'the embedding provider returned no vector for the query',
    );
    return;
  }
  const added = spec
    ? await vectorCandidatesOutside(reads, arm.entries, arm.queryVector, spec)
    : [];
  if (added.length > 0) {
    arm.addedRows = true;
    arm.entries = currentEntries([...arm.entries, ...added], options);
    for (const [id, v] of await reads.stored(
      'vectors',
      added.map((e) => e.id),
    )) {
      vectors.set(id, v);
    }
  }
  arm.embeddingIndex = Object.fromEntries(vectors);
  arm.useEmbeddings = true;
}

/** The stored vectors of the arm's rows; null when the index needs a rebuild or none can
 * be used. */
async function usableVectors(
  arm: VectorArm,
  source: VectorSource,
  provider: EmbeddingProvider,
  spec: HybridVectorCandidates | undefined,
): Promise<Map<string, ArrayLike<number>> | null> {
  const reads = source.vectors;
  const index = await reads.embeddingIndexState();
  if (indexNeedsRebuild(indexedModel(index), provider.id)) {
    warnBm25Fallback('reindex', reindexHint(source));
    return null;
  }
  const vectors = await reads.stored(
    'vectors',
    arm.entries.map((e) => e.id),
  );
  // Only spend a (possibly paid, off-box) query embedding when there is a stored vector this search
  // can use.
  if (vectors.size === 0 && !(spec !== undefined && index.hasVectors)) return null;
  return vectors;
}

/** The query's vector, or null once the embedding budget ran out. */
async function embedWithinBudget(
  query: string,
  provider: EmbeddingProvider,
  options: VectorArmOptions,
): Promise<number[] | null> {
  const vec = await embedQueryBy(
    options.queryEmbedDeadline ?? startQueryEmbedDeadline(options),
    provider,
    query,
  );
  if (vec === null) {
    const budgetMs = queryEmbedBudgetMs(options.runtime?.queryEmbedTimeoutMs);
    warnBm25Fallback(
      'query-embed-budget',
      `the ${provider.kind} embedding provider gave no query vector within ${budgetMs} ms`,
    );
  }
  return vec;
}

export interface DenseScores {
  cosine: number[];
  /** Whether each entry had a cached doc vector to compare against. */
  hadVec: boolean[];
}

export function denseScores(arm: VectorArm): DenseScores {
  const n = arm.entries.length;
  const cosine: number[] = Array<number>(n).fill(0);
  const hadVec: boolean[] = Array<boolean>(n).fill(false);
  if (!arm.useEmbeddings) return { cosine, hadVec };
  for (let i = 0; i < n; i++) {
    const cached = arm.embeddingIndex[arm.entries[i].id];
    hadVec[i] = Boolean(cached && arm.queryVector.length > 0);
    cosine[i] = hadVec[i] ? Math.max(0, cosineOf(arm.queryVector, cached)) : 0;
  }
  return { cosine, hadVec };
}
