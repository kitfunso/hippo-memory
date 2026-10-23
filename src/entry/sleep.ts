// The root entry's sleep and consolidation: each opens one handle per store and fills the outside services that a
// caller's Context or options leave out.
import { defaultStore, withSharedStoreHandles } from '../surface/open-store.js';
import type { SleepStore } from '../store/port.js';
import { runConsolidation, type ConsolidateOptions } from '../domain/consolidate/sleep.js';
import { anthropicLlmFromEnv } from '../infra/ports.js';
import { loadConfig } from '../host/config-file.js';
import { DEFAULT_TENANT_ID } from '../base/util/tenant.js';
import type { ConsolidationResult } from '../domain/consolidate/run.js';
import { sleep as sleepStore, type SleepOpts, type SleepResult } from '../api/sleep/sleep.js';
import type { EntrySleepContext as SleepContext } from '../api/types.js';
import { withEntryInfra } from '../surface/entry-infra.js';

export { ConsolidationResult } from '../domain/consolidate/run.js';
export type { SleepOpts, SleepResult } from '../api/sleep/sleep.js';
// Named in the signatures of sleep and consolidate, so a caller needs them to type its own variable.
export type { SleepContext, SleepStore };

/** Sleeps the whole store under `ctx`, whose store sets the groups a sleep pass works on. */
export async function sleep(ctx: SleepContext, opts?: SleepOpts): Promise<SleepResult> {
  // One handle per store, as `hippo sleep` has: a pass that opened its own would make each close hippo.db's last, which
  // checkpoints and deletes the WAL.
  return withSharedStoreHandles(() => sleepStore(withEntryInfra(ctx), opts));
}

/** consolidate's options as published: the LLM phases call the model ANTHROPIC_API_KEY opens, over `fetcher`. */
type PublishedConsolidateOptions = Omit<ConsolidateOptions, 'llm'> & { fetcher?: typeof fetch };

/** Run a full consolidation pass on `store`, or on the hippo.db under a folder. With no `options.config`, a folder
 * reads its config.json and a store the defaults. */
export async function consolidate(
  target: string | SleepStore,
  options: PublishedConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const [store, root] = isFolder(target) ? [defaultStore(target), target] : [target, ''];
  const { fetcher, ...rest } = options;
  const config = options.config ?? loadConfig(root);
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const llm = anthropicLlmFromEnv(fetcher);
  // One handle per store, for the reason `sleep` gives.
  return withSharedStoreHandles(() => runConsolidation(store, { ...rest, config, tenantId, llm }));
}

function isFolder(target: string | SleepStore): target is string {
  return typeof target === 'string';
}

// The one dedupe.js export that is public; the rest of dedupe.js stays internal.
export { strengthTieKey as strengthBucket } from '../domain/consolidate/dedupe.js';
