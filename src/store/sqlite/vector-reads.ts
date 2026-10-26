// hippo.db's vector reads: the nearest-row scan yields between chunks, so its handle stays open until it settles.
import { loadPhysicsState } from '../../db/physics-state.js';
import { graphServesStore } from '../../db/vector-graph-index.js';
import { GraphFileIndex } from '../../db/vector-graph-reader.js';
import type { VectorIndex } from '../../db/vector-store.js';
import type { Handles } from './open.js';
import { handlesOf, openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';
import { rethrowInPortTerms } from './port-errors.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import type { StoredPart, StoredParts, VectorReads } from '../../base/ports/store.js';
import type { NearestIdsAsk } from '../../base/ports/store/vectors.js';
import { entriesInOrder, listVectorCandidateEntries } from './search-rows.js';
import { readStoredVectorViews, storedIndexState } from './vector-index.js';

type RowReads = Omit<VectorReads, 'nearestEntries'>;

type PartReads = {
  readonly [P in StoredPart]: (
    db: DatabaseSyncLike,
    ids: readonly string[],
  ) => Map<string, StoredParts[P]>;
};

const storedBodies: PartReads = {
  vectors: readStoredVectorViews,
  particles: (db, ids) => loadPhysicsState(db, [...ids]),
};

const rowReadsBodies: Bodies<RowReads> = {
  embeddingIndexState: storedIndexState,
  stored: (db, part, ids) => storedBodies[part](db, ids),
};

/** `index` is the store worker's vector graph on the one reader thread that holds it; every other reader searches the
 * graph file saved beside hippo.db. */
export function sqliteVectorReads(
  { on, onAsync, files }: Handles,
  index: VectorIndex = new GraphFileIndex(files.hippoRoot),
): VectorReads {
  const reads = bound(on, rowReadsBodies);
  return {
    ...reads,
    // An empty list needs no handle.
    stored: (part, ids) =>
      ids.length === 0 ? Promise.resolve(new Map()) : reads.stored(part, ids),
    // The scan reads a page per event-loop turn, so the handle stays open until the promise settles.
    nearestEntries: (queryVector, spec) =>
      onAsync((db) => listVectorCandidateEntries(db, queryVector, spec, index), openStore).catch(
        rethrowInPortTerms,
      ),
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
    const ids = on((db) => graphServesStore(db, maxVectors))
      ? await ask(queryVector, spec)
      : undefined;
    return ids === undefined
      ? local.nearestEntries(queryVector, spec)
      : on((db) => entriesInOrder(db, ids));
  };
  return { ...store, vectors: { ...local, nearestEntries } };
}
