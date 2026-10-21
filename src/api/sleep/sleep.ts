// The sleep cycle: decay, consolidation, dedupe, graph extraction and the other maintenance passes.

import type { AmbientState } from '../../base/memory/ambient.js';
import type { SleepContext } from '../types.js';
import { runSleep } from './sleep-run.js';

/** Options for `sleep`, one consolidation cycle on a store with the sleep groups that returns counts; unlike
 * `hippo sleep` it skips the auto-learn step. */
export interface SleepOpts {
  /** Report what a sleep would change without applying it; sharing, the ambient summary and the graph refresh are
   * skipped. */
  dryRun?: boolean;
  /** Skip copying high-scoring memories to the global store under `HIPPO_HOME`. Default false, so every tenant's
   * memories are eligible; multi-tenant callers pass `true`. */
  noShare?: boolean;
}

export interface SleepResult {
  active: number;
  removed: number;
  /** Faded memories the decay pass moved to the dormant store instead of deleting (config `dormant.enabled`); absent
   * when 0. Per-invocation counter, like `removed`. */
  dormant?: number;
  /** Dormant memories deleted for good this sleep for outliving `dormant.retentionDays`; absent when 0. Per-invocation
   * counter, like `removed`. */
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
  /** Memories the auto-share secret veto withheld: rows that passed every other gate but `detectSecret`; absent when 0
   * or auto-share did not run. */
  secretSkipped?: number;
  /** Auto-share candidates the GLOBAL store's rejection tombstone refused (one must not abort the batch); absent when 0
   * or auto-share did not run. */
  rejectedSkipped?: number;
  ambient?: AmbientState | null;
  /** Graph re-extraction totals across tenants rebuilt this sleep; absent when none was dirty or under dryRun.
   * Cross-tenant aggregate: one reason /v1/sleep stays loopback-only. */
  graph?: { tenants: number; entities: number; relations: number };
  details?: string[];
}

/** Sleeps the WHOLE store, every tenant, so /v1/sleep stays loopback-only; never auto-deletes pinned, raw, kept or
 * object-backing rows. */
export async function sleep(ctx: SleepContext, opts: SleepOpts = {}): Promise<SleepResult> {
  return runSleep(ctx, opts);
}
