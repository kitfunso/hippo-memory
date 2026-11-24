import {
  COMPACTION_DB_WAIT_MS,
  REPLAY_AFTER_MS,
  TRANSCRIPT_FILL_WINDOW_MS,
} from '../../../base/session/compaction-timing.js';
import {
  errorFields,
  errorMessage,
  log as hippoLog,
  reportCompactionFailure,
} from '../../../base/util/log.js';
import { isSqliteBusy, type DatabaseSyncLike } from '../../../db/index.js';
import {
  closeStartedWithoutSummary,
  nextCompactionStart,
  openTranscriptRows,
  stalledSummarizedRows,
} from './compaction-rows.js';
import {
  compactionByRequest,
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
import { spoolRequestId } from './spool-request-id.js';
import { answered, bound, type Bodies } from '../runtime/bound.js';
import { type Handles, type OnHandle, type StoreFiles, waitingOpener } from '../runtime/open.js';
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
} from '../../../base/ports/store/capture.js';
import { handleNow } from '../runtime/handle-clock.js';

const noteTo =
  (notes: string[]): Log =>
  (message, err) => {
    if (err === undefined) {
      notes.push(message);
      return;
    }
    notes.push(`${message}: ${errorMessage(err)}`);
    hippoLog.warn(`compaction: ${message}`, errorFields(err));
  };

const iso = (ms: number): string => new Date(ms).toISOString();

function itemContext(
  tenantId: string,
  record: CompactionRef,
  items: readonly string[],
): ItemContext {
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
    const record = recordSummary(step.db, step.files, step.tenantId, {
      meta: step.meta,
      text: step.text,
      at: step.at,
    });
    step.result.snapshotSaved = record.snapshotSaved;
    return record;
  } catch (err) {
    if (isSqliteBusy(err)) throw err;
    reportCompactionFailure(step.log, 'record step', errorMessage(err), errorFields(err));
    return null;
  }
}

function itemsStep(step: SaveStep, record: CompactionRecord | null): void {
  const { meta, files, log } = step;
  try {
    step.result.written = saveItems(step.db, {
      files,
      ctx: {
        tenantId: step.tenantId,
        recordId: record?.id ?? null,
        sessionId: meta.sessionId,
        originProject: record?.originProject ?? compactionOrigin(files, meta.cwd),
        cwd: meta.cwd,
        items: step.text.items,
      },
      log,
      baseHalfLifeDays: step.baseHalfLifeDays,
    });
  } catch (err) {
    if (!isSqliteBusy(err) || record === null) throw err;
    step.result.deferred = true;
    log('store busy, items left for the next sleep', err);
  }
}

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
    reportCompactionFailure(log, 'items step', errorMessage(err), errorFields(err));
  }
  return { result, spoolReason: null, notes };
}

function saveStalled(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  opts: StalledOptions,
): StalledSaved {
  const notes: string[] = [];
  const log = noteTo(notes);
  let saved = 0;
  for (const row of stalledSummarizedRows(
    db,
    tenantId,
    iso(files.clock().getTime() - REPLAY_AFTER_MS),
  )) {
    if (Date.now() > opts.deadline) break;
    try {
      const record = toRecord(row);
      if (record === null) continue;
      saveItems(db, {
        files,
        ctx: itemContext(tenantId, record, record.items),
        log,
        baseHalfLifeDays: opts.baseHalfLifeDays,
      });
      saved++;
    } catch (err) {
      if (isSqliteBusy(err)) {
        log(`store busy, replay stopped at ${row.id}; the next sleep resumes it`, err);
        break;
      }
      log(`replay of ${row.id} failed`, err);
    }
  }
  return { saved, notes };
}

function recordSpooled(
  db: DatabaseSyncLike,
  files: StoreFiles,
  spooled: SpooledSummary,
): RecordedCompaction {
  const { tenantId, payload, importKey } = spooled;
  const requestId = importKey === undefined ? undefined : spoolRequestId(importKey);
  const earlier =
    requestId === undefined
      ? null
      : compactionByRequest(db, { tenantId, requestId, sessionId: payload.sessionId });
  const { id, sessionId, originProject, cwd, items } =
    earlier ??
    recordSummary(db, files, tenantId, {
      meta: payload,
      text: spooled.text,
      at: spooled.at,
      caller: { requestId },
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
    saveItems(db, {
      files,
      ctx: itemContext(tenantId, record, record.items),
      log: noteTo(notes),
      baseHalfLifeDays: opts.baseHalfLifeDays,
    });
    return { notes, failure: null };
  } catch (err) {
    return { notes, failure: { busy: isSqliteBusy(err), message: errorMessage(err) } };
  }
}

function openRecords(db: DatabaseSyncLike, tenantId: string): OpenCompaction[] {
  const now = handleNow(db).getTime();
  const rows = openTranscriptRows(db, {
    tenantId,
    startedBefore: iso(now - REPLAY_AFTER_MS),
    startedAfter: iso(now - TRANSCRIPT_FILL_WINDOW_MS),
  });
  return rows.flatMap((row) => {
    const record = toRecord(row);
    if (record === null) return [];
    const { id, sessionId, originProject, cwd, transcriptPath, startedAt } = record;
    const next = { tenantId: record.tenantId, sessionId, after: startedAt };
    const nextStartedAt = nextCompactionStart(db, next);
    return [{ id, sessionId, originProject, cwd, transcriptPath, startedAt, nextStartedAt }];
  });
}

interface Fill {
  readonly tenantId: string;
  readonly record: OpenCompaction;
  readonly text: CompactionText | null;
  readonly log: Log;
}

function fillRecord(
  db: DatabaseSyncLike,
  files: StoreFiles,
  fill: Fill,
  baseHalfLifeDays: number,
): boolean {
  const { tenantId, record, text, log } = fill;
  if (text === null) {
    if (closeStartedWithoutSummary(db, tenantId, record.id) > 0) {
      log(`${record.id} closed as no-summary: its transcript holds no summary for it`);
    }
    return false;
  }
  if (
    !markSummarized(db, tenantId, record.id, { text, summarizedAt: files.clock().toISOString() })
  ) {
    log(`${record.id} was filled by another process`);
    return false;
  }
  saveItems(db, { files, ctx: itemContext(tenantId, record, text.items), log, baseHalfLifeDays });
  return true;
}

interface FillCall {
  readonly tenantId: string;
  readonly record: OpenCompaction;
  readonly text: CompactionText | null;
  readonly opts: ItemsOptions;
}

function fill(
  db: DatabaseSyncLike,
  files: StoreFiles,
  { tenantId, record, text, opts }: FillCall,
): FillOutcome {
  const notes: string[] = [];
  const log = noteTo(notes);
  try {
    return {
      saved: fillRecord(db, files, { tenantId, record, text, log }, opts.baseHalfLifeDays),
      notes,
    };
  } catch (err) {
    log(`transcript fill of ${record.id} failed`, err);
    return { saved: false, notes };
  }
}

type HookWaited = Pick<CompactionHooks, 'start' | 'markSnapshotSaved'>;

function hookBodies(files: StoreFiles): Bodies<HookWaited> {
  return {
    start: (db, tenantId, start) =>
      startCompaction(db, tenantId, {
        ...start,
        originProject: compactionOrigin(files, start.cwd),
      }),
    markSnapshotSaved: markSnapshotSaved,
  };
}

export function sqliteCompactionHooks({ on, files }: Handles): CompactionHooks {
  return {
    ...bound(on, hookBodies(files), waitingOpener(COMPACTION_DB_WAIT_MS)),
    save: (save) => answered(() => saveCompaction(on, save)),
    saveStalled: (tenantId, opts) =>
      answered(() =>
        on((db) => saveStalled(db, files, tenantId, opts), waitingOpener(opts.busyWaitMs)),
      ),
    recordSpooled: (spooled, wait) =>
      answered(() => on((db) => recordSpooled(db, files, spooled), waitingOpener(wait.busyWaitMs))),
    saveRecordItems: (tenantId, record, opts) =>
      answered(() =>
        on(
          (db) => saveRecordItems(db, files, tenantId, record, opts),
          waitingOpener(opts.busyWaitMs),
        ),
      ),
    openRecords: (tenantId, wait) =>
      answered(() => on((db) => openRecords(db, tenantId), waitingOpener(wait.busyWaitMs))),
    fill: (tenantId, record, text, opts) =>
      answered(() =>
        on(
          (db) => fill(db, files, { tenantId, record, text, opts }),
          waitingOpener(opts.busyWaitMs),
        ),
      ),
  };
}
