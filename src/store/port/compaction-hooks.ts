// The local compaction hooks' record work: synchronous and hippo.db's own, since the spool and the transcript a replay
// reads sit beside the folder.
import type { CompactionStart } from './compactions.js';

/** Every method logs a failure through `log` and never throws, so a hook still exits 0. */
export interface CompactionHooks {
  /** PreCompact's `started` record; its id, or null. */
  start(tenantId: string, start: Omit<CompactionStart, 'originProject'>, log: Log): string | null;
  /** Marks the record as having its snapshot saved. */
  markSnapshotSaved(tenantId: string, recordId: string, log: Log): void;
  /** PostCompact's save: the summary's record, then its items; `spoolReason` is set when the store was busy. */
  save(save: CompactionSave): CompactionSaveOutcome;
  /** Finishes what a killed hook or a busy store left; how many compactions it saved. */
  replay(tenantId: string, sources: ReplaySources, log: Log, opts: ReplayOptions): number;
}

export type Log = (message: string) => void;

/** One PostCompact summary to save; its items start on `baseHalfLifeDays`, the config default. */
export interface CompactionSave {
  readonly tenantId: string;
  readonly meta: Omit<CompactionStart, 'originProject'>;
  readonly text: CompactionText;
  readonly at: Date;
  readonly log: Log;
  readonly baseHalfLifeDays: number;
}

export interface CompactionText {
  summary: string;
  items: string[];
}

export interface CompactionSaveResult {
  /** Memories written; null when neither the record nor the items could be saved. */
  written: number | null;
  /** True when the rest waits for the next sleep or post-compact. */
  deferred: boolean;
  snapshotSaved: boolean;
}

/** What one PostCompact save did; `spoolReason` is set when the store was busy or would not open, so the caller keeps
 * the summary on disk. */
export interface CompactionSaveOutcome {
  result: CompactionSaveResult;
  spoolReason: string | null;
}

/** One spooled summary, as plain data. */
export interface SpooledSummary {
  tenantId: string;
  payload: Omit<CompactionStart, 'originProject'>;
  text: CompactionText;
  at: Date;
}

/** Records one spooled summary; it calls `recorded` once the store holds it, so the file is done even if a later step
 * throws. */
export type SpoolRecorder = (spooled: SpooledSummary, recorded: () => void) => void;

/** A summary read out of a transcript, scrubbed; `listed` is false when it had no memories section. */
export interface TranscriptText {
  text: CompactionText;
  listed: boolean;
}

/** The file work a replay needs, handed in by the caller so the store holds none of it. */
export interface ReplaySources {
  /** Feeds each spooled summary to `record`; returns how many it imported. */
  importSpool(tenantId: string, deadline: number, record: SpoolRecorder): number;
  transcriptExists(transcriptPath: string): boolean;
  /** The summary a transcript holds between two moments, or null when it is not (yet) there. */
  transcriptText(transcriptPath: string, afterMs: number, beforeMs: number): TranscriptText | null;
}

export interface ReplayOptions {
  busyWaitMs?: number;
  deadline?: number;
  /** The config default a replayed item's memory starts on. */
  baseHalfLifeDays: number;
}
