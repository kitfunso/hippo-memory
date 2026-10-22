// Capture and compaction: `hippo capture`'s rows, the compaction hooks' record work and the Compactions group.
import type { HeldText } from './types.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { TenantId } from '../../base/util/tenant.js';

// `hippo capture`'s reads and writes: each row is mirrored beside the folder, and the caller embeds what was captured.
export interface Captures {
  /** Each entry stamped, through the write gate and mirrored, in order in one transaction; one outcome per entry. The
   * caller leaves out texts its dedup read found and repeats within the batch; the write reads `opts.dedup` again in
   * its transaction and skips an entry whose text a row holds by then, so two captures never store one text twice. */
  write(entries: readonly MemoryEntry[], opts: CaptureWriteOptions): Promise<CapturedOutcome[]>;
  /** The rows holding any of `words`, for the dedup before a write; a row equal to a text apart from spacing holds its
   * every word. `project` keeps rows carrying one of those names plus user-global rows, `everyScope` lifts the
   * team-visible filter for a reader that sees the whole store. */
  textsHolding(tenantId: TenantId, words: readonly string[], opts?: TextsHoldingOptions): Promise<HeldText[]>;
}

/** Which rows a `textsHolding` read keeps beyond the tenant. */
export interface TextsHoldingOptions {
  readonly project?: readonly string[];
  readonly everyScope?: boolean;
}

export type CapturedOutcome = 'captured' | 'skipped' | 'rejected';

export interface CaptureWriteOptions {
  readonly actor?: string;
  /** No stats, as in a server process. */
  readonly lean: boolean;
  /** The rows the caller's dedup read: textsHolding's tenant and filter. */
  readonly dedup: CaptureDedup;
}

/** Which rows count as holding a capture's text, as `textsHolding` takes them. */
export interface CaptureDedup {
  readonly tenantId: TenantId;
  readonly project?: readonly string[];
  readonly everyScope?: boolean;
}

// The local compaction hooks' record work, as data: the spool and the transcript a replay reads stay with the surface,
// and each line a step would log comes back as a note for the surface's own log.
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
interface StoreWait {
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

// The Compactions group, kept apart from port.ts: the record and items of a compaction a caller on another machine
// sends, under the caller's tenant and project, never the server's folder or environment.
export interface Compactions {
  /** A `started` record; its id. */
  start(tenantId: string, start: CompactionStart): Promise<string>;
  /** Marks the record as having its snapshot saved; an id the tenant does not hold changes nothing. */
  markSnapshotSaved(tenantId: string, recordId: string): Promise<void>;
  /** The items under the request's record, all in one transaction, so two sessions never both write one text; a request
   * id another session holds rejects with ConflictError. */
  saveCallerItems(tenantId: string, req: CallerItems): Promise<CallerItemsSaved>;
}

export interface CallerItemsSaved {
  /** Memories written; a retry of a finished request answers with the first count. */
  readonly written: number;
  /** One line per kind of item left out, and why. */
  readonly notes: readonly string[];
}

export interface CompactionStart {
  sessionId: string;
  originProject: string;
  trigger: string | null;
  cwd: string | null;
  transcriptPath: string | null;
}

export interface CallerItems {
  readonly sessionId: string;
  readonly trigger: string | null;
  readonly requestId: string;
  readonly project: string;
  readonly items: readonly string[];
  /** The caller's audit actor and its project's names. */
  readonly owner: string;
  readonly origins: readonly string[];
  /** The config default the caller's items start on. */
  readonly baseHalfLifeDays: number;
}
