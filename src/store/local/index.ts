// What a hippo.db root keeps beside the port: the local files it reads and writes in process, and the stores a call on
// it reaches. The port never imports this folder.
import { hasGroup, type HippoStore, type StoreGroup } from '../port.js';
import type { LocalFiles } from './local-files.js';

export type {
  AgentImport,
  Captures,
  CompactionHooks,
  Consolidation,
  ContainerTx,
  EmbeddingIndex,
  FolderFiles,
  ImportTarget,
  Ledger,
  LocalFiles,
} from './local-files.js';

/** A store with a folder's local files beside the port: the one hippo.db builds, which sleep and the CLI need. */
export type LocalStore = HippoStore & { readonly localFiles: LocalFiles };

/** True when `store` carries local files. */
export function isLocalStore(store: HippoStore): store is LocalStore {
  const local: Partial<LocalStore> = store;
  return local.localFiles !== undefined;
}

/** What a route, tool or add-on route needs of its store: a port group, or a folder's local files. */
export type StoreNeed = StoreGroup | 'localFiles';

/** True when `store` serves `need`, so a gate answers 501 before the handler runs. */
export function storeMeets(store: HippoStore, need: StoreNeed): boolean {
  return need === 'localFiles' ? isLocalStore(store) : hasGroup(store, need);
}

/** A local store and the folder it sits in, for work that reads both: sharing, sync, embedding and the global store. */
export interface FolderStore {
  readonly root: string;
  readonly store: LocalStore;
}

/** Which stores a call reaches, probed once by a composition root so the api reads this instead of the disk. */
export interface StoreReach {
  readonly hasLocal: boolean; // the primary store has a project of its own, or has no local files
  readonly isGlobal: boolean; // the primary root is the operator's global store
  readonly shared: boolean; // a store serving many people, so the operator's global store stays out
  readonly global?: { readonly root: string; readonly store: HippoStore }; // set only when readable
  readonly isHippoDb?: boolean; // the primary store has local files, whose folder `hippo embed` and sleep reach
  readonly globalTarget?: FolderStore; // where share, promote and sync write; on a local store, perhaps not created
}

/** The operator's global stores a server opens beside its own, closed with it. */
export interface GlobalStores {
  readonly open: (root: string) => LocalStore;
  readonly close: () => Promise<void>;
}
