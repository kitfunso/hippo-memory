// hippo.db's EmbeddingIndex: the folder-keyed vector functions, which each open and close their own handle.
import { embeddingModelRequiresReindex, saveStoredEmbeddingModel } from '../embeddings/index.js';
import { countAllEntries, loadAllEntryIds, loadEntriesByIds } from '../entry-reads.js';
import type { EmbeddingIndex } from '../port/embedding-index.js';
import {
  loadEmbeddingIndex, loadStoredParticles, pruneStoredVectorsListPending, resetStoredParticles, saveEmbeddingIndex,
  saveStoredVectors, seedStoredParticle, storedVectorSummary,
} from '../vector-index.js';

export function sqliteEmbeddingIndex(hippoRoot: string): EmbeddingIndex {
  return {
    requiresReindex: (providerId) => embeddingModelRequiresReindex(hippoRoot, providerId),
    saveModel: (providerId) => saveStoredEmbeddingModel(hippoRoot, providerId),
    entryCount: () => countAllEntries(hippoRoot),
    entryIds: () => loadAllEntryIds(hippoRoot),
    entriesByIds: (ids) => loadEntriesByIds(hippoRoot, ids),
    vectors: () => loadEmbeddingIndex(hippoRoot),
    summary: () => storedVectorSummary(hippoRoot),
    particles: () => loadStoredParticles(hippoRoot),
    saveVectors: (rows, model) => saveStoredVectors(hippoRoot, rows, model),
    replaceVectors: (index, model) => saveEmbeddingIndex(hippoRoot, index, model),
    pruneListPending: () => pruneStoredVectorsListPending(hippoRoot),
    resetParticles: (ids, index) => resetStoredParticles(hippoRoot, ids, index),
    seedParticle: (entry, vector) => seedStoredParticle(hippoRoot, entry, vector),
  };
}
