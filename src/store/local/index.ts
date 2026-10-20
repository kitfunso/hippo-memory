// What a hippo.db root keeps beside the port: the local files it reads and writes in process, and the stores a call on
// it reaches. The port never imports this folder.
import { hasGroup, type HippoStore, type StoreGroup, type StoreGroups } from '../port.js';
import type { LocalFiles } from './local-files.js';

export type {
  AgentImport,
  Captures,
  CompactionHooks,
  Consolidation,
  ContainerTx,
  FolderFiles,
  ImportTarget,
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

/** The operator's global stores a server opens beside its own, closed with it. */
export interface GlobalStores {
  readonly open: (root: string) => LocalStore & StoreGroups;
  readonly close: () => Promise<void>;
}
