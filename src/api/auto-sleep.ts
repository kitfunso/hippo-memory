// When a write starts a background sleep; the MCP remember tool and the session-close hook share it.

import { log } from '../log.js';
import { countCreatedSinceLastSleep } from '../store/index-and-stats.js';
import { consolidate } from '../consolidate/sleep.js';
import { outsideRequestStores, runWithRequestStores, scopedBusyWait } from '../db.js';
import { resolveTenantId } from '../tenant.js';
import type { HippoConfig } from '../config.js';

export const autoSleepInFlight = new Set<string>();

export interface AutoSleepDue {
  enabled: boolean;
  count: number;
  threshold: number;
  due: boolean;
}

/** Counts only when enabled: the count opens the store. */
export function autoSleepDue(hippoRoot: string, tenantId: string, config: HippoConfig['autoSleep']): AutoSleepDue {
  const { enabled, threshold } = config;
  const count = enabled ? countCreatedSinceLastSleep(hippoRoot, tenantId) : 0;
  return { enabled, count, threshold, due: enabled && count >= threshold };
}

/** One run per store at a time; `allowed` is the caller's own gate. Consolidation is host-wide, so only the host tenant may start it. */
export function startAutoSleepIfDue(hippoRoot: string, tenantId: string, config: HippoConfig['autoSleep'], allowed: boolean): void {
  if (
    !allowed ||
    !config.enabled ||
    tenantId !== resolveTenantId({}) ||
    autoSleepInFlight.has(hippoRoot) ||
    !autoSleepDue(hippoRoot, tenantId, config).due
  ) return;
  autoSleepInFlight.add(hippoRoot);
  // Fire-and-forget (never block the response); an unhandled rejection would kill the server, so log it.
  // Its own scope: the call's closes a handle the sleep still holds across its pauses, but the caller's lock wait carries over.
  const busyWaitMs = scopedBusyWait();
  outsideRequestStores(() => runWithRequestStores(() => consolidate(hippoRoot), { busyWaitMs }))
    .catch((err) => {
      log.error(`auto-sleep consolidate failed (tenant ${tenantId}): ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => autoSleepInFlight.delete(hippoRoot));
}
