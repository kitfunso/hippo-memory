// The ./server entry's prompt hook: an add-on's Context gets the reach a root probes for its
// store's folder and the entry's real ports, so the add-on renders what the hippo server would.
import { contextReach, type ContextReach, type EntryContext } from '../../api/index.js';
import {
  buildPromptHookContext as renderPromptHook,
  type PromptHookOptions,
  type PromptHookRequest,
} from '../../api/prompt-hook.js';
import { loadConfig } from '../../host/config-file.js';
import type { EmbedderFor } from '../../base/ports/embedder.js';
import type { HippoStore } from '../../base/ports/store.js';
import { coreEnrichment } from '../../api/hippo-db-context.js';
import { ledgerHomeOf } from '../../api/ledger-db.js';
import { entryHost, withEntryInfra } from '../entry-infra.js';
import { sqliteReach } from '../open-store.js';

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

/** The reach every root probes for a store kept in a folder, from the folder its tier names; a
 * store without one keeps the Context's default, one project and no global store. */
async function folderReach(
  store: HippoStore,
  embedderFor: EmbedderFor,
  opts: PromptHookOptions | undefined,
): Promise<ContextReach | undefined> {
  const enrich = coreEnrichment(store);
  if (enrich?.folderFiles === undefined) return undefined;
  const { folder } = await enrich.folderFiles.home();
  const reach = sqliteReach({
    hippoRoot: folder,
    store,
    shared: opts?.sharedStore,
    openGlobal: undefined,
    host: entryHost,
  });
  return contextReach(reach, loadConfig, embedderFor, ledgerHomeOf(enrich, loadConfig(folder)));
}
