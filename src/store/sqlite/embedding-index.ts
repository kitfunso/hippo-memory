// hippo.db's EmbeddingIndex. The model checks take the opener, since an unreadable index there reads as none.
import { randomUUID } from 'node:crypto';
import { closeHippoDb } from '../../db/index.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { countAllEntries, loadEntriesByIds, loadEntryIdsById } from './entry-reads.js';
import type { EmbeddingIndex } from '../port/vectors.js';
import {
  type VectorRebuild,
  beginVectorRebuild,
  embeddingModelRequiresReindex,
  particleStats,
  pendingVectorIds,
  pruneOrphanVectors,
  resetStoredParticles,
  saveStoredEmbeddingModel,
  seedStoredParticle,
  storedVectorSummary,
  vectorCoverage,
} from './vector-index.js';
import type { Handles } from './open.js';
import { openStore } from './handles.js';
import { bound, boundWithFiles, type Bodies, type FileBodies } from './bound.js';
import { dropVectorStaging, upsertVectors } from '../../db/vector-store.js';
import type { Sync } from './served.js';
import { embedLockKey, releaseEmbedLock, tryEmbedLock } from './embed-lock.js';

// The staged vectors live in a TEMP table, which only the handle that made it sees, so the rebuild keeps one open; a
// worker's handle outlives it, so the table is dropped too.
function beginRebuild(open: Handles['open']): VectorRebuild {
  const db = open();
  try {
    return beginVectorRebuild(db, () => {
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

const entryRowsBodies: Bodies<Pick<EmbeddingIndex, 'entryCount' | 'entryIdsPage' | 'entriesByIds' | 'coverage'>> = {
  entryCount: countAllEntries,
  entryIdsPage: loadEntryIdsById,
  entriesByIds: (db, ids) => loadEntriesByIds(db, ids, ALL_TENANTS),
  coverage: vectorCoverage,
};

type Particles = 'resetParticles' | 'seedParticle';

type Rebuilds = 'beginRebuild' | 'stageRebuild' | 'commitRebuild' | 'closeRebuild';

type VectorRows = Pick<EmbeddingIndex, 'summary' | 'particleStats' | 'saveVectors' | 'pruneOrphans' | 'pendingIds'>;

const vectorRowsBodies: Bodies<VectorRows> = {
  summary: storedVectorSummary,
  particleStats: particleStats,
  saveVectors: upsertVectors,
  pruneOrphans: pruneOrphanVectors,
  pendingIds: pendingVectorIds,
};

// A particle's start strength is scored, so these take the store's loss-aversion rules beside the handle.
const particlesBodies: FileBodies<Pick<EmbeddingIndex, Particles>> = {
  resetParticles: resetStoredParticles,
  seedParticle: seedStoredParticle,
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
    ...bound(on, entryRowsBodies, openStore),
    ...bound(on, vectorRowsBodies),
    ...boundWithFiles(on, particlesBodies),
    ...sqliteRebuilds(open),
    lockKey: () => embedLockKey(files.hippoRoot),
    tryLock: () => tryEmbedLock(files.hippoRoot),
    unlock: (token) => releaseEmbedLock(files.hippoRoot, token),
  };
}
