// The local compaction hooks' record work, as data: the spool and the transcript a replay reads stay with the surface,
// and each line a step would log comes back as a note for the surface's own log.
import type { CompactionStart } from './compactions.js';

/** Each method opens hippo.db with the hook's wait, so a busy store costs the hook a bounded delay. */
export interface CompactionHooks {
  /** PreCompact's `started` record; its id. */
  start(tenantId: string, start: Omit<CompactionStart, 'originProject'>): Promise<string>;
  /** Marks the record as having its snapshot saved. */
  markSnapshotSaved(tenantId: string, recordId: string): Promise<void>;
  /** PostCompact's save: the summary's record, then its items. Never throws. */
  save(save: CompactionSave): Promise<CompactionSaveOutcome>;
  /** Writes the items of `summarised` records a killed hook or a busy store left, until `deadline`. */
  saveStalled(tenantId: string, opts: StalledOptions): Promise<StalledSaved>;
  /** Puts one spooled summary on its record, as its PostCompact would have; the record its items go under. */
  recordSpooled(spooled: SpooledSummary, wait: StoreWait): Promise<RecordedCompaction>;
  /** Writes a recorded summary's items; a failure is answered beside the notes logged before it. */
  saveRecordItems(tenantId: string, record: RecordedCompaction, opts: ItemsOptions): Promise<ItemsSaved>;
  /** The `started` records whose PostCompact never came, young enough that their transcript may still hold them. */
  openRecords(tenantId: string, wait: StoreWait): Promise<OpenCompaction[]>;
  /** Fills an open record with the summary its transcript held, or closes it as no-summary when `text` is null. */
  fill(tenantId: string, record: OpenCompaction, text: CompactionText | null, opts: ItemsOptions): Promise<FillOutcome>;
}

/** One PostCompact summary to save; its items start on `baseHalfLifeDays`, the config default. */
export interface CompactionSave {
  readonly tenantId: string;
  readonly meta: Omit<CompactionStart, 'originProject'>;
  readonly text: CompactionText;
  readonly at: Date;
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
  notes: string[];
}

/** One spooled summary, as plain data. */
export interface SpooledSummary {
  tenantId: string;
  payload: Omit<CompactionStart, 'originProject'>;
  text: CompactionText;
  at: Date;
}

/** How long a call waits on a locked store; unset is the store's default wait. */
export interface StoreWait {
  readonly busyWaitMs?: number;
}

/** The config default a replayed item's memory starts on. */
export interface ItemsOptions extends StoreWait {
  readonly baseHalfLifeDays: number;
}

/** No record is started after `deadline`, a Date.now() value. */
export interface StalledOptions extends ItemsOptions {
  readonly deadline: number;
}

export interface StalledSaved {
  saved: number;
  notes: string[];
}

/** A record as its items' save needs it. */
export interface CompactionRef {
  readonly id: string;
  readonly sessionId: string;
  readonly originProject: string;
  /** Where the session ran, so rows held under the project's older folder name count too. */
  readonly cwd: string | null;
}

export interface RecordedCompaction extends CompactionRef {
  readonly items: readonly string[];
}

/** A `started` record and its session's next compaction start, which ends the transcript window it fills from. */
export interface OpenCompaction extends CompactionRef {
  readonly transcriptPath: string | null;
  readonly startedAt: string;
  readonly nextStartedAt: string | null;
}

/** Why a step failed; `busy` when the store was locked, so a replay stops and a later one tries again. */
export interface StepFailure {
  readonly busy: boolean;
  readonly message: string;
}

export interface ItemsSaved {
  notes: string[];
  failure: StepFailure | null;
}

export interface FillOutcome {
  /** True when the record took the summary and its items were written. */
  saved: boolean;
  notes: string[];
}
