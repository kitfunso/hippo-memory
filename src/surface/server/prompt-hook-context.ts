// The ./server entry's prompt hook: an add-on's Context gets the reach a root probes for its store's folder and the
// entry's real ports, so the add-on renders what the hippo server would.
import { contextReach, type ContextReach, type EntryContext } from '../../api/index.js';
import {
  promptHookContext as renderPromptHook,
  type PromptHookOptions,
  type PromptHookRequest,
} from '../../api/prompt-hook.js';
import { loadConfig } from '../../host/config-file.js';
import { resolveEmbeddingProvider } from '../../infra/embedding-provider.js';
import { hasGroup, type HippoStore } from '../../store/port.js';
import { entryHost, withEntryInfra } from '../entry-infra.js';
import { defaultReach } from '../open-store.js';

export async function promptHookContext(
  ctx: EntryContext,
  req: PromptHookRequest,
  opts?: PromptHookOptions,
): ReturnType<typeof renderPromptHook> {
  const reach = ctx.reach ?? (await folderReach(ctx.store, opts));
  return renderPromptHook(withEntryInfra({ ...ctx, reach }), req, opts);
}

/** The reach every root probes for a store kept in a folder, from the folder its port names; a store without
 * folderFiles keeps the Context's default, one project and no global store. */
async function folderReach(store: HippoStore, opts: PromptHookOptions | undefined): Promise<ContextReach | undefined> {
  if (!hasGroup(store, 'folderFiles')) return undefined;
  const { folder } = await store.folderFiles.home();
  const reach = defaultReach(folder, store, opts?.sharedStore, undefined, entryHost);
  return contextReach(reach, loadConfig, resolveEmbeddingProvider);
}
