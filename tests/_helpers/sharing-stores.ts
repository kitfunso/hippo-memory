// The two sides a sharing call takes, built from folders as the CLI builds them, and the copy a share wrote.
import { getGlobalRoot } from '../../src/host/global-store.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/host/config-file.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import type { ConfiguredFolder } from '../../src/base/config/configured-folder.js';
import type { HippoStore, StoreGroups } from '../../src/base/ports/store.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import type { ShareOutcome } from '../../src/domain/sharing/share.js';

/** A folder's store, config and the real embedder, with the folder a test reopens. */
export type TestFolder = ConfiguredFolder<HippoStore & StoreGroups> & { readonly root: string };

/** The folder's hippo.db beside its folder, with its config as the CLI loads it. */
export function folderStore(root: string): TestFolder {
  return { root, store: sqliteStore(root), config: loadConfig(root), embedderFor: resolveEmbeddingProvider };
}

/** The store under `localRoot` and the global store: the operator's own unless `globalRoot` names another folder. */
export function sharingStores(localRoot: string, globalRoot: string = getGlobalRoot()): [TestFolder, TestFolder] {
  return [folderStore(localRoot), folderStore(globalRoot)];
}

/** The global copy a share wrote; a case that expects one fails when the share did anything else. */
export function sharedEntry(outcome: ShareOutcome): MemoryEntry {
  if (outcome.kind !== 'shared') throw new Error(`expected a shared copy, got ${outcome.kind}`);
  return outcome.entry;
}
