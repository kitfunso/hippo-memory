// The one module that builds a folder's embedding target for the entries, so eval-scripts, the eval
// kit's embedMemory and a server's embedAll all get the same target.
import { folderEmbedTarget, type EmbedTarget } from '../domain/search/embed-memories.js';
import type { ConfiguredFolder } from '../base/config/configured-folder.js';
import type { HippoStore } from '../base/ports/store.js';
import { resolveEmbeddingProvider } from '../infra/embedding-provider.js';
import { entryInfra } from './entry-infra.js';

/** A folder's embedding target, embedding with the real provider its config names. */
export function folderIndex(
  folder: Omit<ConfiguredFolder<HippoStore>, 'embedderFor'>,
): EmbedTarget | undefined {
  return folderEmbedTarget({ ...folder, embedderFor: resolveEmbeddingProvider }, entryInfra());
}
