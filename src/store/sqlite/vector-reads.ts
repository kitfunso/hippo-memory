// hippo.db's vector reads. Async only: the nearest-row scan yields between chunks, so a store worker awaits these where
// it runs every other method to its end.
import { loadPhysicsState } from '../../db/physics-state.js';
import type { VectorIndex } from '../../db/vector-store.js';
import type { Handles } from './open.js';
import { openStore } from './handles.js';
import type { VectorReads } from '../port.js';
import { loadVectorCandidateEntriesAt } from './search-rows.js';
import { loadStoredVectorsAt, storedIndexStateAt } from './vector-index.js';

/** `index` is the store worker's vector graph, on the one reader thread that holds it. */
export function sqliteVectorReads({ on, onAsync }: Handles, index?: VectorIndex): VectorReads {
  return {
    embeddingIndexState: async () => on(storedIndexStateAt),
    storedVectors: async (ids) => on((db) => loadStoredVectorsAt(db, ids)),
    // The scan keeps its cursor open across event-loop turns, so the handle stays open until the promise settles.
    nearestEntries: (queryVector, spec) =>
      onAsync((db) => loadVectorCandidateEntriesAt(db, queryVector, spec, index), openStore),
    // loadPhysicsState reads every row for an empty list.
    physicsParticles: async (ids) => (ids.length === 0 ? new Map() : on((db) => loadPhysicsState(db, [...ids]))),
  };
}
