// The two sides a sharing call takes, built from folders as the CLI builds them.
import { getGlobalRoot } from '../../src/sharing/global-store.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/core/config.js';
import type { ConfiguredFolder } from '../../src/search/embed-memories.js';

/** The folder's hippo.db beside its folder, with its config as the CLI loads it. */
export function folderStore(root: string): ConfiguredFolder {
  return { root, store: sqliteStore(root), config: loadConfig(root) };
}

/** The store under `localRoot` and the global store: the operator's own unless `globalRoot` names another folder. */
export function sharingStores(
  localRoot: string,
  globalRoot: string = getGlobalRoot(),
): [ConfiguredFolder, ConfiguredFolder] {
  return [folderStore(localRoot), folderStore(globalRoot)];
}
