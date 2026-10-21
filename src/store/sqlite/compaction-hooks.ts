// hippo.db's CompactionHooks: each call opens with the hook's wait, and every line a step logs comes back as a note.
import {
  COMPACTION_DB_WAIT_MS,
  REPLAY_AFTER_MS,
  TRANSCRIPT_FILL_WINDOW_MS,
} from '../../base/session/compaction-timing.js';
import { errorMessage, reportCompactionFailure } from '../../base/util/log.js';
import { isSqliteBusy, type DatabaseSyncLike } from '../../db/index.js';
import {
  closeStartedWithoutSummary,
  nextCompactionStart,
  openTranscriptRows,
  stalledSummarizedRows,
} from './compaction-rows.js';
import {
  compactionOrigin,
  markSnapshotSaved,
  markSummarized,
  recordSummary,
  saveItems,
  startCompaction,
  toRecord,
  type CompactionRecord,
  type ItemContext,
  type Log,
} from './compactions-record.js';
import { boundWithFiles, type FileBodies } from './bound.js';
import { type OnHandle, type StoreFiles, waitingOpener } from './open.js';
import type { Sync } from './served.js';
import type {
  CompactionHooks,
  CompactionRef,
  CompactionSave,
  CompactionSaveOutcome,
  CompactionSaveResult,
  CompactionText,
  FillOutcome,
  ItemsOptions,
  ItemsSaved,
  OpenCompaction,
  RecordedCompaction,
  SpooledSummary,
  StalledOptions,
  StalledSaved,
} from '../port/capture.js';

const noteTo =
  (notes: string[]): Log =>
  (message) => {
    notes.push(message);
  };

const iso = (ms: number): string => new Date(ms).toISOString();

/** The one place a record becomes the argument saveItems takes. */
function itemContext(tenantId: string, record: CompactionRef, items: readonly string[]): ItemContext {
  return {
    tenantId,
    recordId: record.id,
    sessionId: record.sessionId,
    originProject: record.originProject,
    cwd: record.cwd,
    items: [...items],
  };
}

interface SaveStep extends CompactionSave {
  db: DatabaseSyncLike;
  files: StoreFiles;
  result: CompactionSaveResult;
  log: Log;
}

function recordStep(step: SaveStep): CompactionRecord | null {
  try {
    const record = recordSummary(step.db, step.files.hippoRoot, step.tenantId, {
      meta: step.meta,
      text: step.text,
      at: step.at,
    });
    step.result.snapshotSaved = record.snapshotSaved;
    return record;
  } catch (err) {
    if (isSqliteBusy(err)) throw err;
    reportCompactionFailure(step.log, 'record step', errorMessage(err));
    return null;
  }
}

/** Busy with a saved record defers to sleep; any other failure goes to the caller. */
function itemsStep(step: SaveStep, record: CompactionRecord | null): void {
  const { meta, files, log } = step;
  try {
    step.result.written = saveItems(
      step.db,
      files,
      {
        tenantId: step.tenantId,
        recordId: record?.id ?? null,
        sessionId: meta.sessionId,
        originProject: record?.originProject ?? compactionOrigin(files.hippoRoot, meta.cwd),
        cwd: meta.cwd,
        items: step.text.items,
      },
      log,
      step.baseHalfLifeDays,
    );
  } catch (err) {
    if (!isSqliteBusy(err) || record === null) throw err;
    // The record already holds the items; sleep finishes them.
    step.result.deferred = true;
    log(`store busy, items left for the next sleep: ${errorMessage(err)}`);
  }
}

/** The PostCompact store work, on a handle of its own: record the summary, then write its items. Each step is
 * independent. Never throws. */
function saveCompaction(on: OnHandle, save: CompactionSave): CompactionSaveOutcome {
  const result: CompactionSaveResult = { written: null, deferred: false, snapshotSaved: false };
  const notes: string[] = [];
  const log = noteTo(notes);
  let opened = false;
  try {
    on((db, files) => {
      opened = true;
      const step: SaveStep = { ...save, db, files, result, log };
      itemsStep(step, recordStep(step));
    }, waitingOpener(COMPACTION_DB_WAIT_MS));
  } catch (err) {
    if (isSqliteBusy(err) || !opened) return { result, spoolReason: errorMessage(err), notes };
    reportCompactionFailure(log, 'items step', errorMessage(err));
  }
  return { result, spoolReason: null, notes };
}

/** A row that will not map is skipped and a record that throws is noted, so the rest still run until the deadline. */
function saveStalled(db: DatabaseSyncLike, files: StoreFiles, tenantId: string, opts: StalledOptions): StalledSaved {
  const notes: string[] = [];
  const log = noteTo(notes);
  let saved = 0;
  for (const row of stalledSummarizedRows(db, tenantId, iso(Date.now() - REPLAY_AFTER_MS))) {
    if (Date.now() > opts.deadline) break;
    try {
      const record = toRecord(row);
      if (record === null) continue;
      saveItems(db, files, itemContext(tenantId, record, record.items), log, opts.baseHalfLifeDays);
      saved++;
    } catch (err) {
      log(`replay of ${row.id} failed: ${errorMessage(err)}`);
    }
  }
  return { saved, notes };
}

function recordSpooled(db: DatabaseSyncLike, files: StoreFiles, spooled: SpooledSummary): RecordedCompaction {
  const { id, sessionId, originProject, cwd, items } = recordSummary(db, files.hippoRoot, spooled.tenantId, {
    meta: spooled.payload,
    text: spooled.text,
    at: spooled.at,
  });
  return { id, sessionId, originProject, cwd, items };
}

function saveRecordItems(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  record: RecordedCompaction,
  opts: ItemsOptions,
): ItemsSaved {
  const notes: string[] = [];
  try {
    saveItems(db, files, itemContext(tenantId, record, record.items), noteTo(notes), opts.baseHalfLifeDays);
    return { notes, failure: null };
  } catch (err) {
    return { notes, failure: { busy: isSqliteBusy(err), message: errorMessage(err) } };
  }
}

/** Old enough that their PostCompact will not come, young enough that the transcript may still reach back to them. */
function openRecords(db: DatabaseSyncLike, tenantId: string): OpenCompaction[] {
  const now = Date.now();
  const rows = openTranscriptRows(db, tenantId, iso(now - REPLAY_AFTER_MS), iso(now - TRANSCRIPT_FILL_WINDOW_MS));
  return rows.flatMap((row) => {
    const record = toRecord(row);
    if (record === null) return [];
    const { id, sessionId, originProject, cwd, transcriptPath, startedAt } = record;
    const nextStartedAt = nextCompactionStart(db, record.tenantId, sessionId, startedAt);
    return [{ id, sessionId, originProject, cwd, transcriptPath, startedAt, nextStartedAt }];
  });
}

interface Fill {
  readonly tenantId: string;
  readonly record: OpenCompaction;
  readonly text: CompactionText | null;
  readonly log: Log;
}

function fillRecord(db: DatabaseSyncLike, files: StoreFiles, fill: Fill, baseHalfLifeDays: number): boolean {
  const { tenantId, record, text, log } = fill;
  if (text === null) {
    // The record is past REPLAY_AFTER_MS, so a window that is fully scanned or out of reach stays empty.
    if (closeStartedWithoutSummary(db, tenantId, record.id) > 0) {
      log(`${record.id} closed as no-summary: its transcript holds no summary for it`);
    }
    return false;
  }
  if (!markSummarized(db, tenantId, record.id, { text, summarizedAt: new Date().toISOString() })) {
    log(`${record.id} was filled by another process`);
    return false;
  }
  saveItems(db, files, itemContext(tenantId, record, text.items), log, baseHalfLifeDays);
  return true;
}

interface FillCall {
  readonly tenantId: string;
  readonly record: OpenCompaction;
  readonly text: CompactionText | null;
  readonly opts: ItemsOptions;
}

function fill(db: DatabaseSyncLike, files: StoreFiles, { tenantId, record, text, opts }: FillCall): FillOutcome {
  const notes: string[] = [];
  const log = noteTo(notes);
  try {
    return { saved: fillRecord(db, files, { tenantId, record, text, log }, opts.baseHalfLifeDays), notes };
  } catch (err) {
    log(`transcript fill of ${record.id} failed: ${errorMessage(err)}`);
    return { saved: false, notes };
  }
}

type HookWaited = Pick<CompactionHooks, 'start' | 'markSnapshotSaved'>;

const hookBodies: FileBodies<HookWaited> = {
  start: (db, files, tenantId, start) =>
    startCompaction(db, tenantId, { ...start, originProject: compactionOrigin(files.hippoRoot, start.cwd) }),
  markSnapshotSaved: (db, _files, tenantId, recordId) => markSnapshotSaved(db, tenantId, recordId),
};

export function sqliteCompactionHooks(on: OnHandle): Sync<CompactionHooks> {
  return {
    ...boundWithFiles<HookWaited>(on, hookBodies, waitingOpener(COMPACTION_DB_WAIT_MS)),
    save: (save) => saveCompaction(on, save),
    saveStalled: (tenantId, opts) =>
      on((db, files) => saveStalled(db, files, tenantId, opts), waitingOpener(opts.busyWaitMs)),
    recordSpooled: (spooled, wait) =>
      on((db, files) => recordSpooled(db, files, spooled), waitingOpener(wait.busyWaitMs)),
    saveRecordItems: (tenantId, record, opts) =>
      on((db, files) => saveRecordItems(db, files, tenantId, record, opts), waitingOpener(opts.busyWaitMs)),
    openRecords: (tenantId, wait) => on((db) => openRecords(db, tenantId), waitingOpener(wait.busyWaitMs)),
    fill: (tenantId, record, text, opts) =>
      on((db, files) => fill(db, files, { tenantId, record, text, opts }), waitingOpener(opts.busyWaitMs)),
  };
}
