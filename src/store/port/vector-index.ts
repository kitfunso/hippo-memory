// The VectorIndex group, kept apart from port.ts, which sits at its size cap.

/** What one vector index refresh did: nodes built from scratch, and queued vectors merged in. */
export interface VectorIndexRefresh {
  readonly built: number;
  readonly merged: number;
}

/** The upkeep of a store's own nearest-vector index, run by sleep. */
export interface VectorIndex {
  /** Builds the index when there is none and the store is large, else merges up to `cap` vectors written since. */
  refresh(cap: number): Promise<VectorIndexRefresh>;
}
