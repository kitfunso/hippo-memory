// Code-churn staleness for `hippo invalidate --churn` and sleep's opt-in pass: the repo and project
// it reads, and one run per store, each on its own.

import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { GIT_CALL_TIMEOUT_MS } from '../../base/util/time.js';
import { type ChurnStaleResult, detectChurnStale } from '../../domain/learn/churn-stale.js';
import type { StoreWith } from '../../base/ports/store.js';
import type { Context, ContextWith } from '../types.js';

export type { ChurnStaleResult };

/** A store the repo's memories can live in, and the folder the report names it by. */
export interface ChurnStore {
  readonly root: string;
  readonly store: StoreWith<'learning'>;
}

/** Tags, in each store, the memories of `repoDir`'s project whose files git says have churned. A
 * store that fails gives a result with `error` set, so it never skips the next store or a
 * sleep's later phases. */
async function markChurnStale(
  ctx: Pick<Context, 'tenantId' | 'infra'>,
  stores: readonly ChurnStore[],
  opts: { readonly repoDir: string; readonly dryRun: boolean },
): Promise<{ root: string; result: ChurnStaleResult }[]> {
  const { git, projectIdentity } = ctx.infra.machine;
  const top = git.run(['rev-parse', '--show-toplevel'], {
    cwd: opts.repoDir,
    timeoutMs: GIT_CALL_TIMEOUT_MS,
  });
  if (!top.ok) throw top.error;
  const repo = { root: top.stdout.trim(), git };
  const { name: projectName, legacyName } = projectIdentity(opts.repoDir);
  const detect = { tenantId: ctx.tenantId, projectName, legacyName, dryRun: opts.dryRun };
  const results: { root: string; result: ChurnStaleResult }[] = [];
  for (const { root, store } of stores) {
    try {
      results.push({ root, result: await detectChurnStale(store, repo, detect) });
    } catch (err) {
      // The caller prints the text; the class and stack stay in the debug log.
      log.debug(`churn staleness failed for ${root}: ${errorMessage(err)}`, errorFields(err));
      const failed = { checked: 0, marked: 0, alreadyMarked: 0, skippedPinned: [], preview: [] };
      results.push({ root, result: { ...failed, dryRun: opts.dryRun, error: errorMessage(err) } });
    }
  }
  return results;
}

/** `markChurnStale` over the stores the context reaches: its own, named `root` in the report,
 * and the operator's global store when it is readable and another folder. */
export function markChurnStaleInReach(
  ctx: Pick<ContextWith<'learning'>, 'tenantId' | 'infra' | 'store' | 'reach'>,
  opts: { readonly root: string; readonly repoDir: string; readonly dryRun: boolean },
): Promise<{ root: string; result: ChurnStaleResult }[]> {
  const { global } = ctx.reach ?? {};
  const stores: ChurnStore[] = [{ root: opts.root, store: ctx.store }];
  if (global !== undefined && global.root !== opts.root) {
    stores.push({ root: global.root, store: global.store });
  }
  return markChurnStale(ctx, stores, opts);
}
