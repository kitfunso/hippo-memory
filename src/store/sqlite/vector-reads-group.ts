// hippo.db's vector reads. Async only: the nearest-row scan yields between chunks, so a store worker awaits these where it runs every other method to its end.
import { loadPhysicsState } from '../../db/physics-state.js';
import { embeddingIndexStateAt, loadStoredVectors } from '../../embeddings.js';
import { onHandle } from '../open.js';
import type { VectorReads } from '../port.js';
import { loadVectorCandidateEntries } from '../search-rows.js';

export function sqliteVectorReads(hippoRoot: string): VectorReads {
  return {
    async embeddingIndexState() {
      return embeddingIndexStateAt(hippoRoot);
    },
    async storedVectors(ids) {
      return loadStoredVectors(hippoRoot, ids);
    },
    async nearestEntries(queryVector, spec) {
      return loadVectorCandidateEntries(hippoRoot, queryVector, spec);
    },
    async physicsParticles(ids) {
      // loadPhysicsState reads every row for an empty list.
      return ids.length === 0 ? new Map() : onHandle(hippoRoot, (db) => loadPhysicsState(db, [...ids]));
    },
  };
}
