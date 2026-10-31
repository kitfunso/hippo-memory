// The root entry's sleep and consolidation: each opens one handle per store and fills the outside
// services that a caller's Context or options leave out.
import { sqliteStore, inSqliteSession, withSharedStoreHandles } from '../surface/open-store.js';
import type { HippoStore } from '../base/ports/store.js';
import {
  runConsolidation,
  type ConsolidateOptions,
  type SleepRules,
} from '../domain/consolidate/sleep.js';
import { evalNow, evalSwitches } from '../infra/eval-switches.js';
import { strengthModelFor } from '../base/memory/eval-switches.js';
import type { HippoConfig } from '../base/config/config.js';
import { anthropicLlmFromEnv } from '../infra/ports.js';
import { loadConfig } from '../host/config-file.js';
import { DEFAULT_TENANT_ID } from '../base/util/tenant.js';
import type { ConsolidationResult } from '../domain/consolidate/run.js';
import { sleepWholeStore, type SleepOptions, type SleepResult } from '../api/sleep/sleep.js';
import type { EntryContext } from '../api/types.js';
import { requireHippoDb, withHippoDb } from '../api/hippo-db-context.js';
import { withEntryInfra } from '../surface/entry-infra.js';

export { ConsolidationResult } from '../domain/consolidate/run.js';
export type { SleepOptions, SleepResult } from '../api/sleep/sleep.js';
export type { SleepEvent } from '../api/sleep/events.js';
export type { RescueRank } from '../domain/consolidate/events.js';
export type { DetachedWork } from '../domain/search/detached-work.js';

/** Sleeps the whole store under `ctx`; a store without hippo.db's local tier rejects before any
 * pass runs. */
export async function sleep(ctx: EntryContext, opts?: SleepOptions): Promise<SleepResult> {
  const local = withHippoDb(ctx);
  // One handle per store, as `hippo sleep` has: a pass that opened its own would make each close
  // hippo.db's last, which checkpoints and deletes the WAL.
  return withSharedStoreHandles((session) =>
    sleepWholeStore(
      withEntryInfra({ ...local, store: inSqliteSession(local.store, session) }),
      opts,
    ),
  );
}

/** consolidate's options as published: the LLM phases call the model ANTHROPIC_API_KEY opens,
 * over `fetcher`. */
type PublishedConsolidateOptions = Omit<ConsolidateOptions, 'llm'> & { fetcher?: typeof fetch };

/** Run a full consolidation pass on `store`, or on the hippo.db under a folder. With no
 * `options.config`, a folder reads its config.json and a store the defaults. */
export async function consolidate(
  target: string | HippoStore,
  options: PublishedConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const [opened, root] = isFolder(target) ? [sqliteStore(target), target] : [target, ''];
  const store = requireHippoDb(opened);
  const { fetcher, ...rest } = options;
  const config = options.config ?? loadConfig(root);
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const llm = anthropicLlmFromEnv(fetcher);
  // One handle per store, for the reason `sleep` gives.
  return withSharedStoreHandles((session) =>
    runConsolidation(inSqliteSession(store, session), {
      ...rest,
      config,
      tenantId,
      llm,
      ...sleepRules(rest.now, config),
    }),
  );
}

function isFolder(target: string | HippoStore): target is string {
  return typeof target === 'string';
}

// The one dedupe.js export that is public; the rest of dedupe.js stays internal.
export { strengthTieKey as strengthBucket } from '../domain/consolidate/dedupe.js';

/** The entry's sleep clock and model: the caller's `now`, else HIPPO_FAKE_NOW or the wall clock;
 * the eval switches' model at the config's loss-aversion ratio. */
function sleepRules(now: Date | undefined, config: HippoConfig): SleepRules {
  return { now: now ?? evalNow(), strength: strengthModelFor(evalSwitches(), config.runtime) };
}
