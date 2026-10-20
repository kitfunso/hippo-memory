// hippo.db's EmbeddingIndex. The model checks take the opener, since an unreadable index there reads as none.
import { randomUUID } from 'node:crypto';
import { closeHippoDb } from '../../db/index.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { countAllEntriesAt, loadEntriesByIdsAt, loadEntryIdsPageAt } from './entry-reads.js';
import type { EmbeddingIndex } from '../port/embedding-index.js';
import {
  type VectorRebuild,
  beginVectorRebuildAt,
  embeddingModelRequiresReindex,
  loadStoredParticlesAt,
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
import { dropVectorStaging, upsertVectors } from '../../db/vector-store.js';
import type { Sync } from './served.js';
import { releaseEmbedLock, tryEmbedLock } from './embed-lock.js';

// The staged vectors live in a TEMP table, which only the handle that made it sees, so the rebuild keeps one open; a
// worker's handle outlives it, so the table is dropped too.
function beginRebuild(open: Handles['open']): VectorRebuild {
  const db = open();
  try {
    return beginVectorRebuildAt(db, () => {
      try {
        dropVectorStaging(db);
      } finally {
        closeHippoDb(db);
      }
    });
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

type Rebuilds = 'beginRebuild' | 'stageRebuild' | 'commitRebuild' | 'closeRebuild';

type VectorRows = Pick<EmbeddingIndex, 'summary' | 'particles' | 'saveVectors' | 'pruneOrphans' | 'pendingIds'>;

const vectorRowsAt: Bodies<VectorRows> = {
  summary: storedVectorSummaryAt,
  particles: loadStoredParticlesAt,
  saveVectors: upsertVectors,
  pruneOrphans: pruneOrphanVectorsAt,
  pendingIds: pendingVectorIdsAt,
};

// A particle's start strength is scored, so these take the store's loss-aversion rules beside the handle.
const particlesAt: FileBodies<Pick<EmbeddingIndex, Particles>> = {
  resetParticles: resetStoredParticlesAt,
  seedParticle: seedStoredParticleAt,
};

/** The open rebuilds by id: each holds its handle across calls, so they stay on the thread that began them. */
function sqliteRebuilds(open: Handles['open']): Sync<Pick<EmbeddingIndex, Rebuilds>> {
  const begun = new Map<string, VectorRebuild>();
  const named = (id: string): VectorRebuild => {
    const rebuild = begun.get(id);
    if (rebuild === undefined) throw new Error(`no open vector rebuild '${id}'`);
    return rebuild;
  };
  return {
    beginRebuild: () => {
      const id = randomUUID();
      begun.set(id, beginRebuild(open));
      return id;
    },
    stageRebuild: (id, rows) => named(id).stage(rows),
    commitRebuild: (id, model) => named(id).commit(model),
    closeRebuild: (id) => {
      const rebuild = begun.get(id);
      begun.delete(id);
      rebuild?.close();
    },
  };
}

export function sqliteEmbeddingIndex({ on, open, files }: Handles): Sync<EmbeddingIndex> {
  return {
    requiresReindex: (providerId) => embeddingModelRequiresReindex(on, providerId),
    saveModel: (providerId) => saveStoredEmbeddingModel(on, providerId),
    ...bound(on, entryRowsAt, openStore),
    ...bound(on, vectorRowsAt),
    ...boundWithFiles(on, particlesAt),
    ...sqliteRebuilds(open),
    tryLock: () => tryEmbedLock(files.hippoRoot),
    unlock: (token) => releaseEmbedLock(files.hippoRoot, token),
  };
}
