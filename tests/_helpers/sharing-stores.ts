// The two sides a sharing call takes, built from folders as the CLI builds them.
import { getGlobalRoot } from '../../src/sharing/global-store.js';
import { sqliteStore } from '../../src/store/index.js';
import type { FolderStore } from '../../src/store/port.js';

/** The folder's hippo.db beside its folder. */
export function folderStore(root: string): FolderStore {
  return { root, store: sqliteStore(root) };
}

/** The store under `localRoot` and the global store: the operator's own unless `globalRoot` names another folder. */
export function sharingStores(localRoot: string, globalRoot: string = getGlobalRoot()): [FolderStore, FolderStore] {
  return [folderStore(localRoot), folderStore(globalRoot)];
}
