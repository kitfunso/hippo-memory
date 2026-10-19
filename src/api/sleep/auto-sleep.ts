// When a write starts a background sleep; api remember and the session-close hook share it.

import { errorFields, errorMessage, log } from '../../util/log.js';
import type { HippoStore } from '../../store/port.js';
import type { HippoConfig } from '../../core/config.js';
import type { Context } from '../types.js';

/**
 * Runs one auto-sleep consolidation of `hippoRoot`: the HTTP server passes one that runs it off its event loop, in a
 * child process; stdio passes one that runs it in its own.
 */
export type AutoSleepRunner = (hippoRoot: string) => Promise<void>;

export interface AutoSleepDue {
  enabled: boolean;
  count: number;
  threshold: number;
  due: boolean;
}

/** Counts only when enabled: the count reads the store. */
export async function autoSleepDue(
  store: HippoStore,
  tenantId: string,
  config: HippoConfig['autoSleep'],
): Promise<AutoSleepDue> {
  const { enabled, threshold } = config;
  const count = enabled ? await store.reports.createdSinceLastSleep(tenantId, new Date()) : 0;
  return { enabled, count, threshold, due: enabled && count >= threshold };
}

/**
 * Starts the root's auto-sleep once enough new memories have landed. Consolidation is host-wide, so only the host
 * tenant's writes start one, one per store at a time. Never rejects: the write it follows has landed.
 */
export async function autoSleepAfterWrite(
  ctx: Pick<Context, 'hippoRoot' | 'tenantId' | 'store' | 'config' | 'callers'>,
): Promise<void> {
  const host = ctx.callers?.autoSleep;
  const { hippoRoot, tenantId, store, config } = ctx;
  if (host === undefined || !config.autoSleep.enabled || tenantId !== host.hostTenantId) return;
  if (host.inFlight.has(hippoRoot)) return;
  // Held from the count on, so two writes landing together never both start a sleep.
  host.inFlight.add(hippoRoot);
  let due = false;
  try {
    due = (await autoSleepDue(store, tenantId, config.autoSleep)).due;
  } catch (err) {
    log.warn(`auto-sleep: counting new memories failed, so no sleep started: ${errorMessage(err)}`, errorFields(err));
  } finally {
    if (!due) host.inFlight.delete(hippoRoot);
  }
  if (!due) return;
  // Fire-and-forget (never block the response); an unhandled rejection would kill the server, so log it.
  host
    .run(hippoRoot)
    .catch((err) => {
      log.error(`auto-sleep consolidate failed (tenant ${tenantId}): ${errorMessage(err)}`, errorFields(err));
    })
    .finally(() => host.inFlight.delete(hippoRoot));
}
