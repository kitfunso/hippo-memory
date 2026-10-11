import type { MemoryEntry } from '../core/memory.js';
import { cosineOf } from '../core/cosine.js';
import { indexNeedsRebuild } from '../store/embeddings/index.js';
import { indexedModel } from '../store/vector-index.js';
import type { VectorCandidateSpec } from '../store/search-rows.js';
import { resolveEmbeddingProvider, type EmbeddingProvider } from '../embeddings/provider.js';
import { rethrowIfSqliteBlocked } from '../db/index.js';
import { errorMessage, log } from '../util/log.js';
import { envQueryEmbedTimeoutMs } from '../util/env.js';
import { requireGroup, sqliteStore, type HippoStore, type VectorReads } from '../store/index.js';
import { redactSecretsStrict } from '../util/secret-detect.js';
import { currentEntries, type CurrentnessOptions } from './as-of.js';

/** hybridSearch's vector arm: which rows it may add, plus the caller's JS admission rules (exact private regex, entry filters). */
export type HybridVectorCandidates = VectorCandidateSpec & { admit?: (entry: MemoryEntry) => boolean };

/** What the vector arm produced; fields fill in step by step, so a late failure keeps the rows already added. */
export interface VectorArm {
  entries: MemoryEntry[];
  addedRows: boolean;
  useEmbeddings: boolean;
  embeddingIndex: Record<string, ArrayLike<number>>;
  queryVector: number[];
}

export interface VectorArmOptions extends CurrentnessOptions {
  hippoRoot?: string;
  vectorCandidates?: HybridVectorCandidates;
  /** Where vectors are read; hippo.db under `hippoRoot` when unset. */
  store?: HippoStore;
  /** The deadline a caller already started for this recall's query embedding; a fresh budget when unset. */
  queryEmbedDeadline?: AbortSignal;
}

// Jev's default budget (rerankers/jev.ts): each is one off-box call that a recall waits on.
const QUERY_EMBED_BUDGET_MS = 5_000;

/** How long one recall waits for its query vector, retries included; HIPPO_QUERY_EMBED_TIMEOUT_MS overrides the default. */
function queryEmbedBudgetMs(): number {
  return envQueryEmbedTimeoutMs() ?? QUERY_EMBED_BUDGET_MS;
}

/** One deadline for every query embedding a recall makes, so two stores or a physics fallback share the budget. */
export function startQueryEmbedDeadline(): AbortSignal {
  return AbortSignal.timeout(queryEmbedBudgetMs());
}

/** The query's vector, or null when an API provider outlasts `deadline`; any other provider failure throws as before. */
export async function embedQueryBy(deadline: AbortSignal, provider: EmbeddingProvider, query: string): Promise<number[] | null> {
  // No signal stops an in-process model, so the local provider is not held to the deadline.
  if (provider.kind === 'local') return (await provider.embed([query], 'query'))[0] ?? [];
  try {
    return (await provider.embed([query], 'query', { signal: deadline }))[0] ?? [];
  } catch (err) {
    if (deadline.aborted) return null;
    throw err;
  }
}

// Search runs on every hook prompt, so one line per reason per process says why vectors went unused without flooding stderr.
function warnBm25Fallback(reason: string, detail: string): void {
  log.once(`search.bm25-fallback.${reason}`, 'warn', `hybrid search fell back to BM25 only: ${redactSecretsStrict(detail)}`);
}

function reindexHint(storeKind: string): string {
  const why = 'the embedding index was built by another model or is being rebuilt';
  // `hippo embed` writes only hippo.db, so another store gets its vectors by a rebuild from it.
  return storeKind === 'sqlite'
    ? `${why}; run 'hippo embed'`
    : `${why}; run 'hippo embed' on the SQLite store, then rebuild the '${storeKind}' database from it`;
}

/** The store's vector reads; a store without them answers 501, as any unported path does. */
export function requireVectorReads(store: HippoStore): VectorReads {
  return requireGroup(store, 'vectors');
}

/** The nearest admitted rows not already in `entries`. */
export async function vectorCandidatesOutside(
  reads: VectorReads, entries: readonly MemoryEntry[], queryVector: readonly number[], spec: HybridVectorCandidates,
): Promise<MemoryEntry[]> {
  const inPool = new Set(entries.map((e) => e.id));
  // The port takes data alone: `admit` is this side's rule, and a function cannot be sent to a store on another thread.
  const { admit, ...stored } = spec;
  return (await reads.nearestEntries(queryVector, stored)).filter((e) => !inPool.has(e.id) && (admit?.(e) ?? true));
}

/** Embeds the query and loads stored vectors; any failure leaves BM25 to rank alone. */
export async function resolveVectorArm(query: string, entries: MemoryEntry[], options: VectorArmOptions): Promise<VectorArm> {
  const arm: VectorArm = { entries, addedRows: false, useEmbeddings: false, embeddingIndex: {}, queryVector: [] };
  if (!options.hippoRoot) return arm;
  try {
    await fillVectorArm(arm, query, options.hippoRoot, options);
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    warnBm25Fallback('error', errorMessage(err));
  }
  return arm;
}

// Views when the store has them, so a search copies no vector; the number[] copies score the same.
async function storedVectorsOf(store: HippoStore, reads: VectorReads, ids: readonly string[]): Promise<Map<string, ArrayLike<number>>> {
  return store.vectorViews ? store.vectorViews.storedVectorViews(ids) : reads.storedVectors(ids);
}

async function fillVectorArm(arm: VectorArm, query: string, root: string, options: VectorArmOptions): Promise<void> {
  const provider = resolveEmbeddingProvider(root);
  if (!provider.isAvailable()) return;
  const store = options.store ?? sqliteStore(root);
  const reads = requireVectorReads(store);
  const index = await reads.embeddingIndexState();
  if (indexNeedsRebuild(indexedModel(index), provider.id)) {
    warnBm25Fallback('reindex', reindexHint(store.kind));
    return;
  }
  const spec = options.vectorCandidates;
  const vectors = await storedVectorsOf(store, reads, arm.entries.map((e) => e.id));
  // Only spend a (possibly paid, off-box) query embedding when there is a stored vector this search can use.
  if (vectors.size === 0 && !(spec !== undefined && index.hasVectors)) return;
  const vec = await embedQueryBy(options.queryEmbedDeadline ?? startQueryEmbedDeadline(), provider, query);
  if (vec === null) {
    warnBm25Fallback('query-embed-budget', `the ${provider.kind} embedding provider gave no query vector within ${queryEmbedBudgetMs()} ms`);
    return;
  }
  arm.queryVector = vec;
  if (arm.queryVector.length === 0) {
    warnBm25Fallback('empty-query-vector', 'the embedding provider returned no vector for the query');
    return;
  }
  const added = spec ? await vectorCandidatesOutside(reads, arm.entries, arm.queryVector, spec) : [];
  if (added.length > 0) {
    arm.addedRows = true;
    arm.entries = currentEntries([...arm.entries, ...added], options);
    for (const [id, v] of await storedVectorsOf(store, reads, added.map((e) => e.id))) vectors.set(id, v);
  }
  arm.embeddingIndex = Object.fromEntries(vectors);
  arm.useEmbeddings = true;
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
