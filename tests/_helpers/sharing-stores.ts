// The two sides a sharing call takes, built from folders as the CLI builds them.
import { getGlobalRoot } from '../../src/domain/sharing/global-store.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/base/config/config.js';
import type { ConfiguredFolder } from '../../src/domain/search/embed-memories.js';
import type { LocalStore } from '../../src/store/local/index.js';
import type { StoreGroups } from '../../src/store/port.js';

/** A folder's store and config, with the folder a test reopens. */
export type TestFolder = ConfiguredFolder<LocalStore & StoreGroups> & { readonly root: string };

/** The folder's hippo.db beside its folder, with its config as the CLI loads it. */
export function folderStore(root: string): TestFolder {
  return { root, store: sqliteStore(root), config: loadConfig(root) };
}

/** The store under `localRoot` and the global store: the operator's own unless `globalRoot` names another folder. */
export function sharingStores(localRoot: string, globalRoot: string = getGlobalRoot()): [TestFolder, TestFolder] {
  return [folderStore(localRoot), folderStore(globalRoot)];
}
