// Every rule the person taught this project, for the session-start hook, which sends them all.
import type { MemoryEntry } from '../core/memory.js';
import { compareEntryIdentity } from '../core/compare.js';
import { loadConfig } from '../core/config.js';
import { storeFor } from '../store/index.js';
import type { ContextOpts } from './context-types.js';
import { ambientAdmission, loadPools, planContext, sourceOf } from './context.js';
import type { Context } from './types.js';

/** What a user-rules read needs to know of its caller. */
export type UserRulesOptions = Pick<ContextOpts, 'currentProject' | 'currentSessionId'>;

/** The tenant's user rules for the current project from the project store and the global store, oldest first, each id once; empty when pinned
 * injection is off. Skips the budgeted selection, so a long list is never cut. */
export async function userRulesGet(ctx: Context, opts: UserRulesOptions): Promise<MemoryEntry[]> {
  if (!loadConfig(ctx.hippoRoot).pinnedInject.enabled) return [];
  const pinned: ContextOpts = { ...opts, pinnedOnly: true, includeRecent: 0 };
  const plan = planContext(ctx, pinned, sourceOf(storeFor(ctx)));
  const admission = ambientAdmission(pinned, plan, null);
  const pools = await loadPools(ctx, plan, admission, undefined);

  const rules = new Map<string, MemoryEntry>();
  const keep = (rows: readonly MemoryEntry[], isGlobal: boolean): void => {
    for (const e of rows) {
      if (plan.isUserRule(e, isGlobal) && !rules.has(e.id)) rules.set(e.id, e);
    }
  };
  keep(pools.local.entries, plan.primaryIsGlobal);
  keep(pools.global.entries, true);
  return [...rules.values()].sort((a, b) => Date.parse(a.created) - Date.parse(b.created) || compareEntryIdentity(a, b));
}
