// When a write starts a background sleep; the MCP remember tool and the session-close hook share it.

import { errorFields, errorMessage, log } from '../../util/log.js';
import type { HippoStore } from '../../store/port.js';
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

export interface AutoSleepGate {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly config: HippoConfig['autoSleep'];
  readonly allowed: boolean;
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
 * One run per store at a time; `allowed` is the caller's own gate. Consolidation is host-wide, so only the host tenant
 * may start it. A failed count rejects; the run itself never does. */
export async function startAutoSleepIfDue(
  store: HippoStore,
  { hippoRoot, tenantId, config, allowed }: AutoSleepGate,
  run: AutoSleepRunner,
): Promise<void> {
  if (!allowed || !config.enabled || tenantId !== resolveTenantId({}) || autoSleepInFlight.has(hippoRoot)) return;
  // Held from the count on, so two writes landing together never both start a sleep.
  autoSleepInFlight.add(hippoRoot);
  let due = false;
  try {
    due = (await autoSleepDue(store, tenantId, config)).due;
  } finally {
    if (!due) autoSleepInFlight.delete(hippoRoot);
  }
  if (!due) return;
  // Fire-and-forget (never block the response); an unhandled rejection would kill the server, so log it.
  const started = run(hippoRoot);
  started
    .catch((err) => {
      log.error(`auto-sleep consolidate failed (tenant ${tenantId}): ${errorMessage(err)}`, errorFields(err));
    })
    .finally(() => autoSleepInFlight.delete(hippoRoot));
}
