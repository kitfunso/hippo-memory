// Which stores a call reaches, probed once by a composition root so the api reads this instead of
// the disk.
import type { HippoStore } from '../store.js';

/** A store and the folder its root opened it from; the folder is for the root's own config read. */
export interface FolderStore<S extends HippoStore = HippoStore> {
  readonly root: string;
  readonly store: S;
}

export interface StoreReach {
  readonly hasLocal: boolean; // the primary store has a project of its own, or has no local files
  readonly isGlobal: boolean; // the primary root is the operator's global store
  readonly shared: boolean; // a store serving many people, so the operator's global store stays out
  // Set only when readable; churn marks its rows stale, and a hook books its ledger rows there, each
  // proving the store's local tier where it reads one.
  readonly global?: FolderStore;
  // The primary store has local files, whose folder `hippo embed` and sleep reach.
  readonly isHippoDb?: boolean;
  // Where share, promote and sync write, each proving its local tier; perhaps not created.
  readonly globalTarget?: FolderStore;
}
