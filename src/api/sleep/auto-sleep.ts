// When a write starts a background sleep and what that sleep runs; api remember and the
// session-close hook share it.

import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { HippoStore } from '../../base/ports/store.js';
import type { HippoConfig } from '../../base/config/config.js';
import { logPhaseFailures, type ConsolidationResult } from '../../domain/consolidate/run.js';
import { runConsolidation } from '../../domain/consolidate/sleep.js';
import { strengthOf, type Context, type ContextWith } from '../types.js';

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
  store: HippoStore,
  tenantId: string,
  config: HippoConfig['autoSleep'],
  now: Date,
): Promise<AutoSleepDue> {
  const { enabled, threshold } = config;
  const count = enabled ? await store.reports.createdSinceLastSleep(tenantId, now) : 0;
  return { enabled, count, threshold, due: enabled && count >= threshold };
}

/**
 * Starts the root's auto-sleep once enough new memories have landed. Consolidation is host-wide, so
 * only the host tenant's writes start one, one per store at a time. Never rejects: the write it
 * follows has landed.
 */
export async function autoSleepAfterWrite(
  ctx: Pick<Context, 'tenantId' | 'store' | 'config' | 'callers' | 'infra'>,
): Promise<void> {
  const host = ctx.callers?.autoSleep;
  const { tenantId, store, config } = ctx;
  if (host === undefined || !config.autoSleep.enabled || tenantId !== host.hostTenantId) return;
  if (host.latch.held) return;
  // Held from the count on, so two writes landing together never both start a sleep.
  host.latch.held = true;
  let due = false;
  try {
    due = (await autoSleepDue(store, tenantId, config.autoSleep, ctx.infra.clock())).due;
  } catch (err) {
    log.warn(
      `auto-sleep: counting new memories failed, so no sleep started: ${errorMessage(err)}`,
      errorFields(err),
    );
  } finally {
    if (!due) host.latch.held = false;
  }
  if (!due) return;
  // Fire-and-forget (never block the response); an unhandled rejection would kill the server, so
  // log it.
  host
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
}

/** What one auto-sleep runs: the consolidation alone, its skipped passes logged by the process
 * that ran it. */
export async function autoSleepConsolidate(
  ctx: Pick<
    ContextWith<'consolidation' | 'learning' | 'lessonWrites' | 'auditMaintenance'>,
    'store' | 'config' | 'tenantId' | 'infra'
  >,
): Promise<ConsolidationResult> {
  const { store, config, tenantId, infra } = ctx;
  const result = await runConsolidation(store, {
    config,
    tenantId,
    llm: infra.llm,
    now: infra.clock(),
    strength: strengthOf(ctx),
  });
  logPhaseFailures(result);
  return result;
}
