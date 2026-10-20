// hippo.db's EmbeddingIndex. The model checks take the opener, since an unreadable index there reads as none.
import { closeHippoDb } from '../../db/index.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { countAllEntriesAt, loadEntriesByIdsAt, loadEntryIdsPageAt } from './entry-reads.js';
import type { EmbeddingIndex, VectorRebuild } from '../local/embedding-index.js';
import {
  beginVectorRebuildAt,
  embeddingModelRequiresReindex,
  particleStatsAt,
  pendingVectorIdsAt,
  pruneOrphanVectorsAt,
  resetStoredParticlesAt,
  saveStoredEmbeddingModel,
  seedStoredParticleAt,
  storedVectorSummaryAt,
  vectorCoverageAt,
} from './vector-index.js';
import type { Handles } from './open.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, type Bodies, type FileBodies } from './bound.js';
import { upsertVectors } from '../../db/vector-store.js';

// The staged vectors live in a TEMP table, which only the handle that made it sees, so the rebuild keeps one open.
function beginRebuild(open: Handles['open']): VectorRebuild {
  const db = open();
  try {
    return beginVectorRebuildAt(db, () => closeHippoDb(db));
  } catch (err) {
    closeHippoDb(db);
    throw err;
  }
}

const entryRowsAt: Bodies<Pick<EmbeddingIndex, 'entryCount' | 'entryIdsPage' | 'entriesByIds' | 'coverage'>> = {
  entryCount: countAllEntriesAt,
  entryIdsPage: (db, page) => loadEntryIdsPageAt(db, ALL_TENANTS, page),
  entriesByIds: (db, ids) => loadEntriesByIdsAt(db, ids, ALL_TENANTS),
  coverage: vectorCoverageAt,
};

type Particles = 'resetParticles' | 'seedParticle';

type VectorRows = Omit<
  EmbeddingIndex,
  | 'requiresReindex'
  | 'saveModel'
  | 'beginRebuild'
  | 'entryCount'
  | 'entryIdsPage'
  | 'entriesByIds'
  | 'coverage'
  | Particles
>;

const vectorRowsAt: Bodies<VectorRows> = {
  summary: storedVectorSummaryAt,
  particleStats: particleStatsAt,
  saveVectors: upsertVectors,
  pruneOrphans: pruneOrphanVectorsAt,
  pendingIds: pendingVectorIdsAt,
};

// A particle's start strength is scored, so these take the store's loss-aversion rules beside the handle.
const particlesAt: FileBodies<Pick<EmbeddingIndex, Particles>> = {
  resetParticles: resetStoredParticlesAt,
  seedParticle: seedStoredParticleAt,
};

export function sqliteEmbeddingIndex({ on, open }: Handles): EmbeddingIndex {
  return {
    requiresReindex: (providerId) => embeddingModelRequiresReindex(on, providerId),
    saveModel: (providerId) => saveStoredEmbeddingModel(on, providerId),
    ...bound(on, entryRowsAt, openStore),
    ...bound(on, vectorRowsAt),
    ...boundWithFiles(on, particlesAt),
    beginRebuild: () => beginRebuild(open),
  };
}
