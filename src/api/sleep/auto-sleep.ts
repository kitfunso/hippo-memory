// When a write starts a background sleep; the MCP remember tool and the session-close hook share it.

import { errorFields, errorMessage, log } from '../../util/log.js';
import { countCreatedSinceLastSleep } from '../../store/index-and-stats.js';
import { resolveTenantId } from '../../store/tenant.js';
import type { HippoConfig } from '../../core/config.js';

export const autoSleepInFlight = new Set<string>();

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

/** Counts only when enabled: the count opens the store. */
export function autoSleepDue(hippoRoot: string, tenantId: string, config: HippoConfig['autoSleep']): AutoSleepDue {
  const { enabled, threshold } = config;
  const count = enabled ? countCreatedSinceLastSleep(hippoRoot, tenantId) : 0;
  return { enabled, count, threshold, due: enabled && count >= threshold };
}

/**
 * One run per store at a time; `allowed` is the caller's own gate. Consolidation is host-wide, so only the host tenant
 * may start it. */
export function startAutoSleepIfDue(
  hippoRoot: string,
  tenantId: string,
  config: HippoConfig['autoSleep'],
  allowed: boolean,
  run: AutoSleepRunner,
): void {
  if (
    !allowed ||
    !config.enabled ||
    tenantId !== resolveTenantId({}) ||
    autoSleepInFlight.has(hippoRoot) ||
    !autoSleepDue(hippoRoot, tenantId, config).due
  ) return;
  autoSleepInFlight.add(hippoRoot);
  // Fire-and-forget (never block the response); an unhandled rejection would kill the server, so log it.
  const started = run(hippoRoot);
  started
    .catch((err) => {
      log.error(`auto-sleep consolidate failed (tenant ${tenantId}): ${errorMessage(err)}`, errorFields(err));
    })
    .finally(() => autoSleepInFlight.delete(hippoRoot));
}
