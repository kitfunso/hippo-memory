// hippo.db's vector reads: the nearest-row scan yields between chunks, so its handle stays open until it settles.
import { loadPhysicsState } from '../../db/physics-state.js';
import { graphServesStore } from '../../db/vector-graph-index.js';
import type { VectorIndex } from '../../db/vector-store.js';
import type { Handles } from './open.js';
import { handlesOf, openStore } from './handles.js';
import { bound, skipEmpty, type Bodies } from './bound.js';
import { rethrowInPortTerms } from './port-errors.js';
import type { VectorReads } from '../port.js';
import type { NearestIdsAsk } from '../port/vectors.js';
import { entriesInOrder, loadVectorCandidateEntries } from './search-rows.js';
import { loadStoredVectors, storedIndexState } from './vector-index.js';

type RowReads = Omit<VectorReads, 'nearestEntries'>;

const rowReadsBodies: Bodies<RowReads> = {
  embeddingIndexState: storedIndexState,
  storedVectors: loadStoredVectors,
  physicsParticles: (db, ids) => loadPhysicsState(db, [...ids]),
};

/** `index` is the store worker's vector graph, on the one reader thread that holds it. */
export function sqliteVectorReads({ on, onAsync }: Handles, index?: VectorIndex): VectorReads {
  const reads = bound(on, rowReadsBodies);
  return {
    ...reads,
    // loadPhysicsState reads every row for an empty list.
    physicsParticles: skipEmpty(reads.physicsParticles, () => new Map()),
    // The scan reads a page per event-loop turn, so the handle stays open until the promise settles.
    nearestEntries: (queryVector, spec) =>
      onAsync((db) => loadVectorCandidateEntries(db, queryVector, spec, index), openStore).catch(rethrowInPortTerms),
  };
}

/** `store` with its nearest-row read asking `ask` first while hippo.db under `hippoRoot` holds enough vectors, and no
 * more than `maxVectors`, for a served store to answer from its graph; a smaller store scans as fast as it hops. */
export function askingNearestFirst<S extends { readonly vectors: VectorReads }>(
  hippoRoot: string,
  store: S,
  ask: NearestIdsAsk,
  maxVectors: number,
): S {
  const { on } = handlesOf(hippoRoot);
  const local = store.vectors;
  const nearestEntries: VectorReads['nearestEntries'] = async (queryVector, spec) => {
    const ids = on((db) => graphServesStore(db, maxVectors)) ? await ask(queryVector, spec) : undefined;
    return ids === undefined ? local.nearestEntries(queryVector, spec) : on((db) => entriesInOrder(db, ids));
  };
  return { ...store, vectors: { ...local, nearestEntries } };
}
