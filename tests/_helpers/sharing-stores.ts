// The two stores a sharing call takes, built from folders as the CLI builds them.
import { getGlobalRoot } from '../../src/sharing/global-store.js';
import { sqliteStore, type HippoStore } from '../../src/store/index.js';

/** The store under `localRoot` and the global store: the operator's own unless `globalRoot` names another folder. */
export function sharingStores(localRoot: string, globalRoot: string = getGlobalRoot()): [HippoStore, HippoStore] {
  return [sqliteStore(localRoot), sqliteStore(globalRoot)];
}
