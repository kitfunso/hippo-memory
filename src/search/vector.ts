import type { MemoryEntry } from '../memory.js';
import { cosineSimilarity, embeddingModelRequiresReindex, hasEmbeddings, loadStoredVectors } from '../embeddings.js';
import { loadVectorCandidateEntries, type VectorCandidateSpec } from '../store/search-rows.js';
import { resolveEmbeddingProvider } from '../embedding-provider.js';
import { rethrowIfSqliteBlocked } from '../db.js';
import { log } from '../log.js';
import { redactSecretsStrict } from '../secret-detect.js';
import { currentEntries, type CurrentnessOptions } from './as-of.js';

/** hybridSearch's vector arm: which rows it may add, plus the caller's JS admission rules (exact private regex, entry filters). */
export type HybridVectorCandidates = VectorCandidateSpec & { admit?: (entry: MemoryEntry) => boolean };

/** What the vector arm produced; fields fill in step by step, so a late failure keeps the rows already added. */
export interface VectorArm {
  entries: MemoryEntry[];
  addedRows: boolean;
  useEmbeddings: boolean;
  embeddingIndex: Record<string, number[]>;
  queryVector: number[];
}

export interface VectorArmOptions extends CurrentnessOptions {
  hippoRoot?: string;
  vectorCandidates?: HybridVectorCandidates;
}

// Search runs on every hook prompt, so one line per reason per process says why vectors went unused without flooding stderr.
function warnBm25Fallback(reason: string, detail: string): void {
  log.once(`search.bm25-fallback.${reason}`, 'warn', `hybrid search fell back to BM25 only: ${redactSecretsStrict(detail)}`);
}

/** The nearest admitted rows not already in `entries`. */
export function vectorCandidatesOutside(
  hippoRoot: string, entries: readonly MemoryEntry[], queryVector: readonly number[], spec: HybridVectorCandidates,
): MemoryEntry[] {
  const inPool = new Set(entries.map((e) => e.id));
  return loadVectorCandidateEntries(hippoRoot, queryVector, spec).filter((e) => !inPool.has(e.id) && (spec.admit?.(e) ?? true));
}

/** Embeds the query and loads stored vectors; any failure leaves BM25 to rank alone. */
export async function resolveVectorArm(query: string, entries: MemoryEntry[], options: VectorArmOptions): Promise<VectorArm> {
  const arm: VectorArm = { entries, addedRows: false, useEmbeddings: false, embeddingIndex: {}, queryVector: [] };
  if (!options.hippoRoot) return arm;
  try {
    await fillVectorArm(arm, query, options.hippoRoot, options);
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    warnBm25Fallback('error', err instanceof Error ? err.message : String(err));
  }
  return arm;
}

async function fillVectorArm(arm: VectorArm, query: string, root: string, options: VectorArmOptions): Promise<void> {
  const provider = resolveEmbeddingProvider(root);
  if (!provider.isAvailable()) return;
  if (embeddingModelRequiresReindex(root, provider.id)) {
    warnBm25Fallback('reindex', "the embedding index was built by another model or is being rebuilt; run 'hippo embed'");
    return;
  }
  const spec = options.vectorCandidates;
  const vectors = loadStoredVectors(root, arm.entries.map((e) => e.id));
  // Only spend a (possibly paid, off-box) query embedding when there is a stored vector this search can use.
  if (vectors.size === 0 && !(spec !== undefined && hasEmbeddings(root))) return;
  const [vec] = await provider.embed([query], 'query');
  arm.queryVector = vec ?? [];
  if (arm.queryVector.length === 0) {
    warnBm25Fallback('empty-query-vector', 'the embedding provider returned no vector for the query');
    return;
  }
  const added = spec ? vectorCandidatesOutside(root, arm.entries, arm.queryVector, spec) : [];
  if (added.length > 0) {
    arm.addedRows = true;
    arm.entries = currentEntries([...arm.entries, ...added], options);
    for (const [id, v] of loadStoredVectors(root, added.map((e) => e.id))) vectors.set(id, v);
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
  const cosine: number[] = new Array(n).fill(0);
  const hadVec: boolean[] = new Array(n).fill(false);
  if (!arm.useEmbeddings) return { cosine, hadVec };
  for (let i = 0; i < n; i++) {
    const cached = arm.embeddingIndex[arm.entries[i].id];
    hadVec[i] = Boolean(cached && arm.queryVector.length > 0);
    cosine[i] = hadVec[i] ? Math.max(0, cosineSimilarity(arm.queryVector, cached)) : 0;
  }
  return { cosine, hadVec };
}
