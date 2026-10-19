// hippo.db's vector reads. Async only: the nearest-row scan yields between chunks, so a store worker awaits these where
// it runs every other method to its end.
import { loadPhysicsState } from '../../db/physics-state.js';
import type { VectorIndex } from '../../db/vector-store.js';
import type { Handles } from './open.js';
import { openStore } from './handles.js';
import { bound, boundAsync, skipEmpty, type Bodies } from './bound.js';
import { served } from './served.js';
import type { VectorReads } from '../port.js';
import { loadVectorCandidateEntriesAt } from './search-rows.js';
import { loadStoredVectorsAt, storedIndexStateAt } from './vector-index.js';

type RowReads = Omit<VectorReads, 'nearestEntries'>;

const rowReadsAt: Bodies<RowReads> = {
  embeddingIndexState: storedIndexStateAt,
  storedVectors: loadStoredVectorsAt,
  physicsParticles: (db, ids) => loadPhysicsState(db, [...ids]),
};

/** `index` is the store worker's vector graph, on the one reader thread that holds it. */
export function sqliteVectorReads({ on, onAsync }: Handles, index?: VectorIndex): VectorReads {
  const reads = bound(on, rowReadsAt);
  return {
    // loadPhysicsState reads every row for an empty list.
    ...served<RowReads>({ ...reads, physicsParticles: skipEmpty(reads.physicsParticles, () => new Map()) }),
    // The scan keeps its cursor open across event-loop turns, so the handle stays open until the promise settles.
    ...boundAsync<Pick<VectorReads, 'nearestEntries'>>(
      onAsync,
      { nearestEntries: (db, queryVector, spec) => loadVectorCandidateEntriesAt(db, queryVector, spec, index) },
      openStore,
    ),
  };
}
