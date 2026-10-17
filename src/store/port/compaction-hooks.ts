// The local compaction hooks' record work: synchronous and hippo.db's own, since the environment's tenant, the spool
// and the transcript a replay reads all sit beside the folder.
import type {
  CompactionSaveOutcome, CompactionStart, CompactionText, Log, ReplayOptions, ReplaySources,
} from '../compactions-record.js';

/** Every method logs a failure through `log` and never throws, so a hook still exits 0. */
export interface CompactionHooks {
  /** PreCompact's `started` record under the environment's tenant; its id, or null. */
  start(start: Omit<CompactionStart, 'originProject'>, log: Log): string | null;
  /** Marks the record as having its snapshot saved. */
  markSnapshotSaved(tenantId: string, recordId: string, log: Log): void;
  /** PostCompact's save: the summary's record, then its items; `spoolReason` is set when the store was busy. */
  save(
    meta: Omit<CompactionStart, 'originProject'>, text: CompactionText, at: Date, log: Log, baseHalfLifeDays: number,
  ): CompactionSaveOutcome;
  /** Finishes what a killed hook or a busy store left; how many compactions it saved. */
  replay(sources: ReplaySources, log: Log, opts: ReplayOptions): number;
}
