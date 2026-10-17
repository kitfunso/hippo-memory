// hippo.db's EmbeddingIndex. The model checks take the opener, since an unreadable index there reads as none.
import { embeddingModelRequiresReindex, saveStoredEmbeddingModel } from '../embeddings/index.js';
import { countAllEntriesAt, loadAllEntryIdsAt, loadEntriesByIdsAt } from '../entry-reads.js';
import type { EmbeddingIndex } from '../port/embedding-index.js';
import {
  loadEmbeddingIndexAt, loadStoredParticlesAt, pruneStoredVectorsListPendingAt, resetStoredParticlesAt,
  saveEmbeddingIndexAt,
  saveStoredVectorsAt, seedStoredParticleAt, storedVectorSummaryAt,
} from '../vector-index.js';
import { type OnHandle, openStore } from '../open.js';

export function sqliteEmbeddingIndex(on: OnHandle): EmbeddingIndex {
  return {
    requiresReindex: (providerId) => embeddingModelRequiresReindex(on, providerId),
    saveModel: (providerId) => saveStoredEmbeddingModel(on, providerId),
    entryCount: () => on((db) => countAllEntriesAt(db), openStore),
    entryIds: () => on((db) => loadAllEntryIdsAt(db), openStore),
    entriesByIds: (ids) => on((db) => loadEntriesByIdsAt(db, ids), openStore),
    vectors: () => on((db) => loadEmbeddingIndexAt(db)),
    summary: () => on((db) => storedVectorSummaryAt(db)),
    particles: () => on((db) => loadStoredParticlesAt(db)),
    saveVectors: (rows, model) => on((db) => saveStoredVectorsAt(db, rows, model)),
    replaceVectors: (index, model) => on((db) => saveEmbeddingIndexAt(db, index, model)),
    pruneListPending: () => on((db) => pruneStoredVectorsListPendingAt(db)),
    resetParticles: (ids, index) => on((db) => resetStoredParticlesAt(db, ids, index)),
    seedParticle: (entry, vector) => on((db) => seedStoredParticleAt(db, entry, vector)),
  };
}
