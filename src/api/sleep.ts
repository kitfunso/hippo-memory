// The sleep cycle: decay, consolidation, dedupe, graph extraction and the other maintenance passes.

import type { AmbientState } from '../core/ambient.js';
import type { Context } from './types.js';
import { runSleep } from './sleep-run.js';

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

/** Options for `sleep`, one consolidation cycle on a SQLite store that returns counts; unlike `hippo sleep` it skips the auto-learn step. */
export interface SleepOpts {
  /** Report what a sleep would change without applying it; sharing, the ambient summary and the graph refresh are skipped. */
  dryRun?: boolean;
  /** Skip copying high-scoring memories to the global store under `HIPPO_HOME`. Default false, so every tenant's memories are eligible; multi-tenant callers pass `true`. */
  noShare?: boolean;
}

export interface SleepResult {
  active: number;
  removed: number;
  /**
   * Faded memories the decay pass moved to the dormant store instead of
   * deleting (config `dormant.enabled`). Absent when 0. Per-invocation
   * activity counter, same class as `removed`.
   */
  dormant?: number;
  /**
   * Dormant memories deleted for good this sleep because they outlived
   * `dormant.retentionDays`. Absent when 0. Same per-invocation class as
   * `removed`.
   */
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
  /**
   * Count of memories the auto-share secret veto withheld this sleep
   * — rows that passed every other admission gate (transfer score,
   * not-already-global) and were blocked solely by `detectSecret`. Absent
   * when 0 or when auto-share did not run.
   */
  secretSkipped?: number;
  /**
   * Count of auto-share candidates the GLOBAL store's rejection
   * tombstone refused this sleep; copy paths must not let one rejected
   * candidate abort the batch. Absent when 0 or when auto-share did not run.
   */
  rejectedSkipped?: number;
  ambient?: AmbientState | null;
  /**
   * Graph re-extraction totals across the tenants rebuilt
   * this sleep. Absent when no tenant was dirty, and under dryRun (the graph
   * phase runs only on a real sleep). Cross-tenant aggregate, one reason
   * /v1/sleep stays loopback-only.
   */
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
