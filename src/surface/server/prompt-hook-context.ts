import { contextReach, type ContextReach, type EntryContext } from '../../api/index.js';
import {
  buildPromptHookContext as renderPromptHook,
  type PromptHookOptions,
  type PromptHookRequest,
} from '../../api/prompt-hook.js';
import { loadConfig } from '../../host/config-file.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import { hasGroup, type HippoStore } from '../../base/ports/store.js';
import { entryHost, withEntryInfra } from '../entry-infra.js';
import { defaultReach } from '../open-store.js';

export async function promptHookContext(
  ctx: EntryContext,
  req: PromptHookRequest,
  opts?: PromptHookOptions,
): ReturnType<typeof renderPromptHook> {
  const withInfra = withEntryInfra(ctx);
  const reach =
    withInfra.reach ?? (await folderReach(withInfra.store, withInfra.infra.embedderFor, opts));
  return renderPromptHook({ ...withInfra, reach }, req, opts);
}

async function folderReach(
  store: HippoStore,
  embedderFor: EmbedderFor,
  opts: PromptHookOptions | undefined,
): Promise<ContextReach | undefined> {
  if (!hasGroup(store, 'folderFiles')) return undefined;
  const { folder } = await store.folderFiles.home();
  const reach = defaultReach({
    hippoRoot: folder,
    store,
    shared: opts?.sharedStore,
    openGlobal: undefined,
    host: entryHost,
  });
  const ledger = hasGroup(store, 'ledger')
    ? { ledger: store.ledger, folderFiles: store.folderFiles, config: loadConfig(folder) }
    : undefined;
  return contextReach(reach, loadConfig, embedderFor, ledger);
}
