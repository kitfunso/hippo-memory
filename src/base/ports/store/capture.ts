import type { HeldText } from './types.js';
import type { MemoryEntry } from '../../memory/entry.js';
import type { TenantId } from '../../util/tenant.js';
import type { MethodEffects } from './effects.js';
import type { LogFields } from '../../util/log.js';

export interface Captures {
  write(entries: readonly MemoryEntry[], opts: CaptureWriteOptions): Promise<CapturedOutcome[]>;
  textsHolding(
    tenantId: TenantId,
    texts: readonly string[],
    opts?: TextsHoldingOptions,
  ): Promise<HeldText[]>;
}

/** What each Captures method does to the store; every adapter honours it. */
export const CAPTURES_EFFECTS = {
  write: 'write',
  textsHolding: 'read',
} as const satisfies MethodEffects<Captures>;

/** Which rows a `textsHolding` read keeps beyond the tenant. */
export interface TextsHoldingOptions {
  readonly project?: readonly string[];
  readonly everyScope?: boolean;
}

export type CapturedOutcome = 'captured' | 'skipped' | 'rejected';

export interface CaptureWriteOptions {
  readonly actor?: string;
  readonly lean: boolean;
  readonly dedup: CaptureDedup;
}

/** Which rows count as holding a capture's text, as `textsHolding` takes them. */
export interface CaptureDedup {
  readonly tenantId: TenantId;
  readonly project?: readonly string[];
  readonly everyScope?: boolean;
  readonly ruleProject?: readonly string[];
}

/** Each method opens hippo.db with the hook's wait, so a busy store costs the hook a bounded
 * delay. */
export interface CompactionHooks {
  start(tenantId: string, start: Omit<CompactionStart, 'originProject'>): Promise<string>;
  markSnapshotSaved(tenantId: string, recordId: string): Promise<void>;
  save(save: CompactionSave): Promise<CompactionSaveOutcome>;
  saveStalled(tenantId: string, opts: StalledOptions): Promise<StalledSaved>;
  recordSpooled(spooled: SpooledSummary, wait: StoreWait): Promise<RecordedCompaction>;
  saveRecordItems(
    tenantId: string,
    record: RecordedCompaction,
    opts: ItemsOptions,
  ): Promise<ItemsSaved>;
  openRecords(tenantId: string, wait: StoreWait): Promise<OpenCompaction[]>;
  fill(
    tenantId: string,
    record: OpenCompaction,
    text: CompactionText | null,
    opts: ItemsOptions,
  ): Promise<FillOutcome>;
}

/** What each CompactionHooks method does to the store; every adapter honours it. */
export const COMPACTION_HOOKS_EFFECTS = {
  start: 'write',
  markSnapshotSaved: 'write',
  save: 'write',
  saveStalled: 'write',
  recordSpooled: 'write',
  saveRecordItems: 'write',
  openRecords: 'read',
  fill: 'write',
} as const satisfies MethodEffects<CompactionHooks>;

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
  written: number | null;
  deferred: boolean;
  snapshotSaved: boolean;
}

/** What one PostCompact save did; `spoolReason` is set when the store was busy or would not
 * open, so the caller keeps the summary on disk. */
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
  importKey?: string;
}

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
  readonly cwd: string | null;
}

export interface RecordedCompaction extends CompactionRef {
  readonly items: readonly string[];
}

/** A `started` record and its session's next compaction start, which ends the transcript window
 * it fills from. */
export interface OpenCompaction extends CompactionRef {
  readonly transcriptPath: string | null;
  readonly startedAt: string;
  readonly nextStartedAt: string | null;
}

/** Why a step failed; `busy` when the store was locked, so a replay stops and a later one tries
 * again. */
export interface StepFailure {
  readonly busy: boolean;
  readonly message: string;
  readonly fields?: LogFields;
}

export interface ItemsSaved {
  notes: string[];
  failure: StepFailure | null;
}

export interface FillOutcome {
  saved: boolean;
  notes: string[];
}

export interface Compactions {
  /** A `started` record; its id. */
  start(tenantId: string, start: CompactionStart): Promise<string>;
  /** Marks the record as having its snapshot saved; an id the tenant does not hold changes
   * nothing. */
  markSnapshotSaved(tenantId: string, recordId: string): Promise<void>;
  /** The items under the request's record, all in one transaction, so two sessions never both
   * write one text; a request id another session holds rejects with ConflictError. */
  saveCallerItems(tenantId: string, req: CallerItems): Promise<CallerItemsSaved>;
}

/** What each Compactions method does to the store; every adapter honours it. */
export const COMPACTIONS_EFFECTS = {
  start: 'write',
  markSnapshotSaved: 'write',
  saveCallerItems: 'write',
} as const satisfies MethodEffects<Compactions>;

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
