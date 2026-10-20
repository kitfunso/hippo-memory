// The compaction record's SQL: one record per Claude Code compaction, and the rows its summary's items become.
import * as path from 'path';
import { ConflictError } from '../../core/api-errors.js';
import { COMPACTION_DB_WAIT_MS, REPLAY_AFTER_MS, TRANSCRIPT_FILL_WINDOW_MS } from '../../core/compaction-timing.js';
import { isStringValue } from '../../core/capture-contract.js';
import { itemWords, restates, writableItemRows } from '../../util/compaction-items.js';
import { isSharedStore } from '../../core/config.js';
import { isSqliteBusy, withWriteScopeOr, type DatabaseSyncLike } from '../../db/index.js';
import { gatedWrite } from './gated-write.js';
import {
  COMPACTION_MEMORY_TAG,
  COMPACTION_SOURCE_PREFIX,
  Layer,
  createMemory,
  generateId,
  type MemoryEntry,
} from '../../core/memory.js';
import {
  fallbackOrigin,
  isGlobalStoreRoot,
  projectId,
  projectNames,
  resolveProjectIdentity,
  type ProjectRef,
} from '../../core/project-identity.js';
import {
  closeStartedWithoutSummary,
  compactionProgress,
  compactionRowsByRequest,
  heldMemoryRows,
  insertStartedCompaction,
  insertSummarizedCompaction,
  latestStartedRows,
  markCompactionDone,
  markCompactionSummarized,
  markSnapshotSavedRow,
  nextCompactionStart,
  openTranscriptRows,
  stalledSummarizedRows,
  type CompactionRow,
  type CompactionStatus,
} from './compaction-rows.js';
import { strengthenRetrievedOn, writeEntryMirrors } from './entry-writes.js';
import { isRecallBoostAblated } from '../../core/ablation.js';
import { updateStatsAt } from './index-and-stats.js';
import { type OnHandle, type StoreFiles, waitingOpener } from './open.js';
import { errorFields, errorMessage, log as hippoLog, reportCompactionFailure } from '../../util/log.js';
import type { CompactionStart } from '../port/compactions.js';
import type {
  CompactionSaveOutcome,
  CompactionSaveResult,
  CompactionText,
  Log,
  ReplayOptions,
  ReplaySources,
  SpoolRecorder,
} from '../local/compaction-hooks.js';

export type { CompactionStatus };

export interface CompactionRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  originProject: string;
  trigger: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  snapshotSaved: boolean;
  startedAt: string;
  summarizedAt: string | null;
  summary: string | null;
  items: string[];
  itemsWritten: number;
  status: CompactionStatus;
}

/**
 * Where the session ran: rows written through the global store or a shared store keep the project the session was in.
 */
function compactionProject(hippoRoot: string, cwd: string | null): ProjectRef {
  if (!isGlobalStoreRoot(hippoRoot) && !isSharedStore(hippoRoot)) {
    return resolveProjectIdentity(path.dirname(hippoRoot));
  }
  // No cwd means user-global, as stampOriginProject gives the global store; undefined would fall back to the hook's own
  // cwd.
  return cwd === null ? '' : resolveProjectIdentity(cwd);
}

/** The record column cannot hold NULL, but an item from an unknown folder on a shared store must not read as
 * user-global. */
function itemOrigin(hippoRoot: string, ctx: ItemContext): string | null {
  return ctx.cwd === null && isSharedStore(hippoRoot) ? fallbackOrigin(hippoRoot) : ctx.originProject;
}

function compactionOrigin(hippoRoot: string, cwd: string | null): string {
  return projectId(compactionProject(hippoRoot, cwd));
}

/** The names a record's held rows may carry: its origin, plus the folder name rows saved before project ids used. */
function heldOrigins(hippoRoot: string, cwd: string | null, originProject: string): readonly string[] {
  const names = projectNames(compactionProject(hippoRoot, cwd));
  return names.includes(originProject) ? names : [originProject];
}

/** The item strings a row holds, or null (after a warning naming the row) once its items_json will not parse. */
function rowItems(row: CompactionRow): string[] | null {
  if (row.items_json === null) return [];
  try {
    const listed = JSON.parse(row.items_json);
    return Array.isArray(listed) ? listed.filter(isStringValue) : [];
  } catch (err) {
    hippoLog.warnThenDebug(
      'compaction-items-json',
      `compaction ${row.id} skipped: its items_json is not valid JSON (${errorMessage(err)})`,
      errorFields(err),
    );
    return null;
  }
}

/** The record a row holds, or null for a row whose items cannot be read, so one bad row costs only itself. */
function toRecord(row: CompactionRow): CompactionRecord | null {
  const items = rowItems(row);
  if (items === null) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    originProject: row.origin_project,
    trigger: row.compact_trigger,
    cwd: row.cwd,
    transcriptPath: row.transcript_path,
    snapshotSaved: row.snapshot_saved === 1,
    startedAt: row.started_at,
    summarizedAt: row.summarised_at,
    summary: row.summary,
    items,
    itemsWritten: row.items_written,
    status: row.status,
  };
}

export function startCompaction(
  db: DatabaseSyncLike,
  tenantId: string,
  start: CompactionStart,
  at: Date = new Date(),
): string {
  const id = generateId('cmp');
  insertStartedCompaction(db, tenantId, { id, ...start, startedAt: at.toISOString() });
  return id;
}

/** The record a caller's request made, whatever state it reached, so a retry neither writes its items twice nor starts
 * a second record. Another session's id is a ConflictError. */
export function compactionByRequest(
  db: DatabaseSyncLike,
  tenantId: string,
  requestId: string,
  sessionId: string,
): CompactionRecord | null {
  const record = compactionRowsByRequest(db, tenantId, requestId).map(toRecord)[0] ?? null;
  // Sessions are owner-bound, so this also keeps one owner from reading or finishing another's record.
  if (record !== null && record.sessionId !== sessionId) {
    throw new ConflictError('request id belongs to another session');
  }
  return record;
}

/** Pre-compact's record for the compaction that is ending: the session's newest `started` one within REPLAY_AFTER_MS
 * before `at`. An older one is left for the transcript fill. */
function latestStarted(db: DatabaseSyncLike, tenantId: string, sessionId: string, at: Date): CompactionRecord | null {
  return (
    latestStartedRows(
      db,
      tenantId,
      sessionId,
      at.toISOString(),
      new Date(at.getTime() - REPLAY_AFTER_MS).toISOString(),
    ).map(toRecord)[0] ?? null
  );
}

/** Moves a `started` record to `summarised`; false when another process already moved it.
 * The request id lands in the same statement, so no crash leaves the record unfindable by its retry. */
interface MarkSummarizedOptions {
  readonly text: CompactionText;
  readonly summarizedAt: string;
  readonly requestId?: string;
}

function markSummarized(db: DatabaseSyncLike, tenantId: string, id: string, options: MarkSummarizedOptions): boolean {
  const { text, summarizedAt, requestId } = options;
  return markCompactionSummarized(db, tenantId, id, {
    summary: text.summary,
    itemsJson: JSON.stringify(text.items),
    summarizedAt,
    requestId,
  });
}

/** Best effort, never throws: a compaction must not fail because its record could not be written. */
export function recordCompactionStart(
  on: OnHandle,
  tenantId: string,
  start: Omit<CompactionStart, 'originProject'>,
  log: Log,
): string | null {
  try {
    return on(
      (db, files) =>
        startCompaction(db, tenantId, {
          ...start,
          originProject: compactionOrigin(files.hippoRoot, start.cwd),
        }),
      waitingOpener(COMPACTION_DB_WAIT_MS),
    );
  } catch (err) {
    log(`compaction record not started: ${errorMessage(err)}`);
    return null;
  }
}

/** On the caller's handle and tenant, so a server marks the record under the caller's tenant with its own wait. */
export function markSnapshotSaved(db: DatabaseSyncLike, tenantId: string, recordId: string): void {
  markSnapshotSavedRow(db, tenantId, recordId);
}

export function recordSnapshotSaved(on: OnHandle, tenantId: string, recordId: string, log: Log): void {
  try {
    on((db) => {
      markSnapshotSaved(db, tenantId, recordId);
    }, waitingOpener(COMPACTION_DB_WAIT_MS));
  } catch (err) {
    log(`compaction record not marked with its snapshot: ${errorMessage(err)}`);
  }
}

/** A caller's checked project, and the id its retries carry so a retry finds this record. */
export interface SummaryCaller {
  originProject?: string;
  requestId?: string;
}

export interface RecordSummaryOptions {
  readonly meta: Omit<CompactionStart, 'originProject'>;
  readonly text: CompactionText;
  readonly at: Date;
  readonly caller?: SummaryCaller;
}

/** Puts the summary on the session's `started` record, or inserts a `summarised` one when pre-compact wrote none. One
 * statement each. */
export function recordSummary(
  db: DatabaseSyncLike,
  hippoRoot: string,
  tenantId: string,
  options: RecordSummaryOptions,
): CompactionRecord {
  const { meta, text, at, caller = {} } = options;
  const now = new Date().toISOString();
  const itemsJson = JSON.stringify(text.items);
  const { requestId } = caller;
  const started = latestStarted(db, tenantId, meta.sessionId, at);
  if (started && markSummarized(db, tenantId, started.id, { text, summarizedAt: now, requestId })) {
    return { ...started, summary: text.summary, items: text.items, summarizedAt: now, status: 'summarised' };
  }
  const originProject = caller.originProject ?? compactionOrigin(hippoRoot, meta.cwd);
  const id = generateId('cmp');
  insertSummarizedCompaction(
    db,
    tenantId,
    { ...meta, originProject, startedAt: at.toISOString() },
    { id, summary: text.summary, itemsJson, summarizedAt: now, requestId },
  );
  return {
    id,
    tenantId,
    sessionId: meta.sessionId,
    originProject,
    trigger: meta.trigger,
    cwd: meta.cwd,
    transcriptPath: meta.transcriptPath,
    snapshotSaved: false,
    startedAt: at.toISOString(),
    summarizedAt: now,
    summary: text.summary,
    items: text.items,
    itemsWritten: 0,
    status: 'summarised',
  };
}

export interface ItemContext {
  tenantId: string;
  /** null when the record step failed: the items still go in, with no record to close. */
  recordId: string | null;
  sessionId: string;
  originProject: string;
  /** Where the session ran, so rows held under the project's older folder name count too. */
  cwd: string | null;
  items: string[];
  /** Set when another machine sent the items: its audit actor and its project's names, since the server's folder is
   * neither. */
  caller?: { actor: string; origins: readonly string[] };
}

interface Held {
  /** null for a row this batch wrote, which needs no strengthening. */
  id: string | null;
  sessionId: string | null;
  words: string[];
}

/** Live rows of one tenant and origin that default recall shows: a compaction often restates what an earlier one, or
 * the user, already saved. */
function heldRows(db: DatabaseSyncLike, tenantId: string, origins: readonly string[]): Held[] {
  return heldMemoryRows(db, tenantId, origins).map((r) => ({
    id: r.id,
    sessionId: r.source_session_id,
    words: itemWords(r.content),
  }));
}

interface ItemWrites {
  written: MemoryEntry[];
  repeats: number;
  refused: number;
  restated: string[];
}

function compactionEntry(text: string, ctx: ItemContext, origin: string | null, baseHalfLifeDays: number): MemoryEntry {
  return {
    ...createMemory(text, {
      layer: Layer.Episodic,
      tags: [COMPACTION_MEMORY_TAG],
      source: `${COMPACTION_SOURCE_PREFIX}${ctx.sessionId}`,
      confidence: 'observed',
      kind: 'distilled',
      sourceSessionId: ctx.sessionId,
      tenantId: ctx.tenantId,
      baseHalfLifeDays,
    }),
    originProject: origin,
  };
}

/** Runs inside saveItems' transaction: restatements of held rows are counted, the rest go through the write gate. */
function writeItemRows(
  db: DatabaseSyncLike,
  hippoRoot: string,
  ctx: ItemContext,
  rows: readonly string[],
  baseHalfLifeDays: number,
): ItemWrites {
  const out: ItemWrites = { written: [], repeats: 0, refused: 0, restated: [] };
  const held = heldRows(db, ctx.tenantId, ctx.caller?.origins ?? heldOrigins(hippoRoot, ctx.cwd, ctx.originProject));
  const origin = ctx.caller === undefined ? itemOrigin(hippoRoot, ctx) : ctx.originProject;
  const restated = new Set<string>();
  for (const text of rows) {
    const textWords = itemWords(text);
    const match = held.find((h) => restates(textWords, h.words));
    if (match) {
      out.repeats++;
      if (match.id !== null && match.sessionId !== ctx.sessionId) restated.add(match.id);
      continue;
    }
    // createMemory throws below 3 chars, which would sink the whole transaction.
    if (text.trim().length < 3) {
      out.refused++;
      continue;
    }
    const entry = compactionEntry(text, ctx, origin, baseHalfLifeDays);
    if (gatedWrite(db, hippoRoot, entry, { actor: ctx.caller?.actor ?? 'post-compact' }) === 'written') {
      out.written.push(entry);
      held.push({ id: null, sessionId: ctx.sessionId, words: textWords });
    } else {
      out.refused++;
    }
  }
  out.restated = [...restated];
  return out;
}

/** After commit: report skips, mirror the new rows, bump the counter. */
function finishItemWrites(db: DatabaseSyncLike, hippoRoot: string, writes: ItemWrites, log: Log): void {
  if (writes.repeats > 0) log(`skipped ${writes.repeats} item(s) the store already holds`);
  if (writes.refused > 0) log(`skipped ${writes.refused} item(s) the write gate refused`);
  for (const entry of writes.written) writeEntryMirrors(hippoRoot, entry);
  if (writes.written.length > 0) {
    try {
      updateStatsAt(db, { hippoRoot }, { remembered: writes.written.length });
    } catch (err) {
      // The rows are committed; a counter that could not be bumped must not turn that into a failed step.
      log(`remembered counter not updated: ${errorMessage(err)}`);
    }
  }
}

/** Items that become rows, then the record `done`, in one transaction so two sessions cannot both insert one text.
 * Mirrors after commit. */
export function saveItems(
  db: DatabaseSyncLike,
  files: StoreFiles,
  ctx: ItemContext,
  log: Log,
  baseHalfLifeDays: number,
): number {
  const { hippoRoot } = files;
  const rows = writableItemRows(ctx.items, log);

  let finishedItems = 0;
  const writes = withWriteScopeOr<ItemWrites, null>(db, 'save_items', (rollback) => {
    if (ctx.recordId !== null) {
      // A replayer that read the record before another finished it must not write its items again.
      const current = compactionProgress(db, ctx.tenantId, ctx.recordId);
      if (current?.status !== 'summarised') {
        finishedItems = current?.items_written ?? 0;
        return rollback(null);
      }
    }
    const written = writeItemRows(db, hippoRoot, ctx, rows, baseHalfLifeDays);
    // Said again by another session is the same signal as being recalled; the same session carrying it forward is not.
    const strengthen = { tenantId: ctx.tenantId, recallBoostAblated: isRecallBoostAblated() };
    strengthenRetrievedOn(db, written.restated, strengthen, files);
    if (ctx.recordId !== null) {
      markCompactionDone(db, ctx.tenantId, ctx.recordId, written.written.length);
    }
    return written;
  });
  if (writes === null) {
    log(`${ctx.recordId} was already finished by another process`);
    return finishedItems;
  }
  finishItemWrites(db, hippoRoot, writes, log);
  return writes.written.length;
}

interface SaveStep {
  db: DatabaseSyncLike;
  files: StoreFiles;
  tenantId: string;
  meta: Omit<CompactionStart, 'originProject'>;
  text: CompactionText;
  at: Date;
  result: CompactionSaveResult;
  log: Log;
  baseHalfLifeDays: number;
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
export function saveCompactionAt(on: OnHandle, save: Omit<SaveStep, 'db' | 'files' | 'result'>): CompactionSaveOutcome {
  const result: CompactionSaveResult = { written: null, deferred: false, snapshotSaved: false };
  let opened = false;
  try {
    on((db, files) => {
      opened = true;
      const step: SaveStep = { ...save, db, files, result };
      itemsStep(step, recordStep(step));
    }, waitingOpener(COMPACTION_DB_WAIT_MS));
  } catch (err) {
    if (isSqliteBusy(err) || !opened) return { result, spoolReason: errorMessage(err) };
    reportCompactionFailure(save.log, 'items step', errorMessage(err));
  }
  return { result, spoolReason: null };
}

function closeWithoutSummary(db: DatabaseSyncLike, tenantId: string, id: string, log: Log): void {
  if (closeStartedWithoutSummary(db, tenantId, id) > 0) {
    log(`${id} closed as no-summary: its transcript holds no summary for it`);
  }
}

function nextStartedAt(db: DatabaseSyncLike, record: CompactionRecord): string | null {
  return nextCompactionStart(db, record.tenantId, record.sessionId, record.startedAt);
}

/** The one place a record becomes the argument saveItems takes. */
function itemContext(tenantId: string, record: CompactionRecord, items: string[] = record.items): ItemContext {
  return {
    tenantId,
    recordId: record.id,
    sessionId: record.sessionId,
    originProject: record.originProject,
    cwd: record.cwd,
    items,
  };
}

/** Records a spooled summary, then writes its items. */
function spoolRecorder(db: DatabaseSyncLike, files: StoreFiles, log: Log, baseHalfLifeDays: number): SpoolRecorder {
  return (spooled, recorded) => {
    const record = recordSummary(db, files.hippoRoot, spooled.tenantId, {
      meta: spooled.payload,
      text: spooled.text,
      at: spooled.at,
    });
    // The record holds the items now, so the file is done even if the write below fails.
    recorded();
    saveItems(db, files, itemContext(spooled.tenantId, record), log, baseHalfLifeDays);
  };
}

/** What every replay step reads: the open store, who owns the rows, and the moment and deadline the run works to. */
interface ReplayRun {
  readonly db: DatabaseSyncLike;
  readonly files: StoreFiles;
  readonly tenantId: string;
  readonly now: number;
  readonly sources: ReplaySources;
  readonly log: Log;
  readonly deadline: number;
  readonly baseHalfLifeDays: number;
}

/** Runs `step` over each row until the deadline; a row that will not map is skipped, a step that throws is logged, and
 * the rest still run. Returns how many `step` finished. */
function replayEach(
  run: ReplayRun,
  rows: CompactionRow[],
  what: string,
  step: (record: CompactionRecord) => boolean,
): number {
  let finished = 0;
  for (const row of rows) {
    if (Date.now() > run.deadline) break;
    try {
      const record = toRecord(row);
      if (record !== null && step(record)) finished++;
    } catch (err) {
      run.log(`${what} of ${row.id} failed: ${errorMessage(err)}`);
    }
  }
  return finished;
}

function replayStalled(run: ReplayRun): number {
  const stalled = stalledSummarizedRows(run.db, run.tenantId, new Date(run.now - REPLAY_AFTER_MS).toISOString());
  return replayEach(run, stalled, 'replay', (record) => {
    saveItems(run.db, run.files, itemContext(run.tenantId, record), run.log, run.baseHalfLifeDays);
    return true;
  });
}

function replaySpool(run: ReplayRun): number {
  try {
    const { db, files, log, baseHalfLifeDays } = run;
    return run.sources.importSpool(run.tenantId, run.deadline, spoolRecorder(db, files, log, baseHalfLifeDays));
  } catch (err) {
    run.log(`spool import failed: ${errorMessage(err)}`);
    return 0;
  }
}

/** Fills one open record from its transcript; true when it saved items. */
function fillFromTranscript(run: ReplayRun, record: CompactionRecord): boolean {
  const { db, files, tenantId, sources, log } = run;
  if (record.transcriptPath === null || !sources.transcriptExists(record.transcriptPath)) return false;
  const next = nextStartedAt(db, record);
  const found = sources.transcriptText(
    record.transcriptPath,
    Date.parse(record.startedAt),
    next === null ? Number.POSITIVE_INFINITY : Date.parse(next),
  );
  if (found === null) {
    // The record is past REPLAY_AFTER_MS, so a window that is fully scanned or out of reach stays empty.
    closeWithoutSummary(db, tenantId, record.id, log);
    return false;
  }
  const { text, listed } = found;
  if (!listed) log(`no memories section in the transcript summary for ${record.id}`);
  if (!markSummarized(db, tenantId, record.id, { text, summarizedAt: new Date().toISOString() })) {
    log(`${record.id} was filled by another process`);
    return false;
  }
  saveItems(db, files, itemContext(tenantId, record, text.items), log, run.baseHalfLifeDays);
  return true;
}

function replayOpen(run: ReplayRun): number {
  const open = openTranscriptRows(
    run.db,
    run.tenantId,
    new Date(run.now - REPLAY_AFTER_MS).toISOString(),
    new Date(run.now - TRANSCRIPT_FILL_WINDOW_MS).toISOString(),
  );
  return replayEach(run, open, 'transcript fill', (record) => fillFromTranscript(run, record));
}

/** Finishes what a killed hook or a busy store left: `summarised` records, spool files, and `started` records the
 * transcript can fill. Returns how many compactions it saved. */
function replayCompactions(run: ReplayRun): number {
  return replayStalled(run) + replaySpool(run) + replayOpen(run);
}

/** For `hippo sleep` and post-compact: opens the store itself and never throws. */
export function replayStoredCompactions(
  on: OnHandle,
  tenantId: string,
  sources: ReplaySources,
  log: Log,
  opts: ReplayOptions,
): number {
  try {
    const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
    const { baseHalfLifeDays } = opts;
    return on(
      (db, files) =>
        replayCompactions({
          db,
          files,
          tenantId,
          now: Date.now(),
          sources,
          log,
          deadline,
          baseHalfLifeDays,
        }),
      waitingOpener(opts.busyWaitMs),
    );
  } catch (err) {
    log(`replay failed: ${errorMessage(err)}`);
    return 0;
  }
}
