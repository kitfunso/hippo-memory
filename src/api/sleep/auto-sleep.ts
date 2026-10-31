// When a write starts a background sleep; api remember and the session-close hook share it.

import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { HippoConfig } from '../../base/config/config.js';
import type { Context } from '../types.js';
import { withDetached } from '../detached.js';
import type { SleepCount } from '../enrichment.js';

/**
 * Runs one auto-sleep consolidation of the folder its host was built for: the HTTP server passes
 * one that runs it off its event loop, in a child process; stdio passes one that runs it in its
 * own.
 */
export type AutoSleepRunner = () => Promise<void>;

export interface AutoSleepDue {
  enabled: boolean;
  count: number;
  threshold: number;
  due: boolean;
}

/** Counts only when enabled: the count reads the store. */
export async function autoSleepDue(
  counted: SleepCount,
  tenantId: string,
  config: HippoConfig['autoSleep'],
  now: Date,
): Promise<AutoSleepDue> {
  const { enabled, threshold } = config;
  const count = enabled ? await counted.createdSinceLastSleep(tenantId, now) : 0;
  return { enabled, count, threshold, due: enabled && count >= threshold };
}

/**
 * Starts the root's auto-sleep once enough new memories have landed. Consolidation is host-wide, so
 * only the host tenant's writes start one, one per store at a time. Never rejects: the write it
 * follows has landed.
 */
export async function autoSleepAfterWrite(
  ctx: Pick<Context, 'tenantId' | 'config' | 'callers' | 'infra' | 'detached' | 'enrich'>,
): Promise<void> {
  const host = ctx.callers?.autoSleep;
  // The count runs on the request's own store, through its local tier.
  const counted = ctx.enrich?.sleepCount;
  const { tenantId, config } = ctx;
  if (host === undefined || counted === undefined) return;
  if (!config.autoSleep.enabled || tenantId !== host.hostTenantId) return;
  if (host.latch.held) return;
  // Held from the count on, so two writes landing together never both start a sleep.
  host.latch.held = true;
  let due = false;
  try {
    due = (await autoSleepDue(counted, tenantId, config.autoSleep, ctx.infra.clock())).due;
  } catch (err) {
    log.warn(
      `auto-sleep: counting new memories failed, so no sleep started: ${errorMessage(err)}`,
      errorFields(err),
    );
  } finally {
    if (!due) host.latch.held = false;
  }
  if (!due) return;
  // The root's keeper holds the sleep so its stores outlast it; a context with no keeper waits for
  // it. A failure is logged here once, with the tenant.
  const sleep = host
    .run()
    .catch((err) => {
      log.error(
        `auto-sleep consolidate failed (tenant ${tenantId}): ${errorMessage(err)}`,
        errorFields(err),
      );
    })
    .finally(() => {
      host.latch.held = false;
    });
  await withDetached(ctx, (detached) => detached.detach(sleep));
}
