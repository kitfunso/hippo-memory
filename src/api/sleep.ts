// The sleep cycle: decay, consolidation, dedupe, graph extraction and the other maintenance passes.

import type { AmbientState } from '../core/ambient.js';
import type { Context } from './types.js';
import { runSleep } from './sleep-run.js';

/** Options for `sleep`, one consolidation cycle on a SQLite store that returns counts; unlike `hippo sleep` it skips the auto-learn step. */
export interface SleepOpts {
  /** Report what a sleep would change without applying it; sharing, the ambient summary and the graph refresh are skipped. */
  dryRun?: boolean;
  /** Skip copying high-scoring memories to the global store under `HIPPO_HOME`. Default
   * false, so every tenant's memories are eligible; multi-tenant callers pass `true`. */
  noShare?: boolean;
}

export interface SleepResult {
  active: number;
  removed: number;
  /** Faded memories the decay pass moved to the dormant store instead of deleting (config `dormant.enabled`); absent when 0. Per-invocation counter, like
   * `removed`. */
  dormant?: number;
  /** Dormant memories deleted for good this sleep for outliving `dormant.retentionDays`; absent when 0. Per-invocation counter, like `removed`. */
  dormantExpired?: number;
  mergedEpisodic: number;
  newSemantic: number;
  dryRun: boolean;
  deduped?: {
    removed: number;
    semDups: number;
    epiDups: number;
    crossDups: number;
  };
  audit?: { errorsRemoved: number; warningCount: number };
  shared?: number;
  /** Memories the auto-share secret veto withheld: rows that passed every other gate but `detectSecret`; absent when 0 or auto-share did not run. */
  secretSkipped?: number;
  /** Auto-share candidates the GLOBAL store's rejection tombstone refused (one must not abort the batch); absent when 0 or auto-share did not run. */
  rejectedSkipped?: number;
  ambient?: AmbientState | null;
  /** Graph re-extraction totals across tenants rebuilt this sleep; absent when none was dirty or under dryRun.
   * Cross-tenant aggregate: one reason /v1/sleep stays loopback-only. */
  graph?: { tenants: number; entities: number; relations: number };
  details?: string[];
}

/** Sleeps the WHOLE hippoRoot, every tenant, so /v1/sleep stays loopback-only; SQLite only; never auto-deletes pinned, raw, kept or object-backing rows. */
export async function sleep(ctx: Context, opts: SleepOpts = {}): Promise<SleepResult> {
  if (ctx.store && ctx.store.kind !== 'sqlite') {
    throw new Error(`sleep supports only the sqlite store, not '${ctx.store.kind}'`);
  }
  return runSleep(ctx, opts);
}
