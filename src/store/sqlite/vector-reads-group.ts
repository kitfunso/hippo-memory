// hippo.db's vector reads. Async only: the nearest-row scan yields between chunks, so a store worker awaits these where
// it runs every other method to its end.
import { loadPhysicsState } from '../../db/physics-state.js';
import { type Handles, openStore } from '../open.js';
import type { VectorReads } from '../port.js';
import { loadVectorCandidateEntriesAt } from '../search-rows.js';
import { loadStoredVectorsAt, storedIndexStateAt } from '../vector-index.js';

export function sqliteVectorReads({ on, onAsync }: Handles): VectorReads {
  return {
    embeddingIndexState: async () => on(storedIndexStateAt),
    storedVectors: async (ids) => on((db) => loadStoredVectorsAt(db, ids)),
    // The scan keeps its cursor open across event-loop turns, so the handle stays open until the promise settles.
    nearestEntries: (queryVector, spec) =>
      onAsync((db) => loadVectorCandidateEntriesAt(db, queryVector, spec), openStore),
    // loadPhysicsState reads every row for an empty list.
    physicsParticles: async (ids) => (ids.length === 0 ? new Map() : on((db) => loadPhysicsState(db, [...ids]))),
  };
}
