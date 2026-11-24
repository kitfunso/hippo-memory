import * as path from 'node:path';
import { otherSessionsRequest } from '../../rules/request-ids.js';
import { REPLAY_AFTER_MS } from '../../../base/session/compaction-timing.js';
import { isStringValue } from '../../../base/session/capture-contract.js';
import { itemWords, restates, writableItemRows } from '../../../base/util/compaction-items.js';
import { withWriteScopeOr, type DatabaseSyncLike } from '../../../db/index.js';
import { gatedWrite } from './gated-write.js';
import {
  COMPACTION_MEMORY_TAG,
  COMPACTION_SOURCE_PREFIX,
  Layer,
  createMemory,
  generateId,
  type MemoryEntry,
} from '../../../base/memory/entry.js';
import { projectId, projectNames, type ProjectRef } from '../../../base/scope/project-identity.js';
import { fallbackOrigin } from '../../../host/host.js';
import { isGlobalStoreRoot } from '../../../host/project-identity.js';
import {
  compactionProgress,
  compactionRowsByRequest,
  heldMemoryRows,
  insertStartedCompaction,
  insertSummarizedCompaction,
  latestStartedRows,
  markCompactionDone,
  markCompactionSummarized,
  markSnapshotSavedRow,
  type CompactionRow,
  type CompactionStatus,
} from './compaction-rows.js';
import { strengthenRetrievedOn, writeEntryMirrors } from '../entries/entry-writes.js';
import { updateStats } from '../entries/index-and-stats.js';
import type { StoreFiles } from '../runtime/open.js';
import { errorFields, errorMessage, log as hippoLog } from '../../../base/util/log.js';
import type { CompactionStart, CompactionText } from '../../../base/ports/store/capture.js';
import { handleNow, handleStamp } from '../runtime/handle-clock.js';

export type { CompactionStatus };

/** Where a step's lines go: a hook's log file, or the notes a port method answers. A line that
 * carries the error it caught also reaches the shared logger with that error's fields. */
export type Log = <E>(message: string, err?: E) => void;

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

function compactionProject({ host, hippoRoot }: StoreFiles, cwd: string | null): ProjectRef {
  if (!isGlobalStoreRoot(hippoRoot) && !host.isSharedStore(hippoRoot)) {
    return host.projectIdentity(path.dirname(hippoRoot));
  }
  return cwd === null ? '' : host.projectIdentity(cwd);
}

function itemOrigin({ host, hippoRoot }: StoreFiles, ctx: ItemContext): string | null {
  return ctx.cwd === null && host.isSharedStore(hippoRoot)
    ? fallbackOrigin(host, hippoRoot)
    : ctx.originProject;
}

export function compactionOrigin(files: StoreFiles, cwd: string | null): string {
  return projectId(compactionProject(files, cwd));
}

function heldOrigins(
  files: StoreFiles,
  cwd: string | null,
  originProject: string,
): readonly string[] {
  const names = projectNames(compactionProject(files, cwd));
  return names.includes(originProject) ? names : [originProject];
}

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

/** The record a row holds, or null for a row whose items cannot be read, so one bad row costs
 * only itself. */
export function toRecord(row: CompactionRow): CompactionRecord | null {
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
  at: Date = handleNow(db),
): string {
  const id = generateId('cmp');
  insertStartedCompaction(db, tenantId, { id, ...start, startedAt: at.toISOString() });
  return id;
}

interface CompactionRequestOptions {
  readonly tenantId: string;
  readonly requestId: string;
  readonly sessionId: string;
}

/** The record a caller's request made, whatever state it reached, so a retry neither writes its
 * items twice nor starts a second record. Another session's id is a ConflictError. */
export function compactionByRequest(
  db: DatabaseSyncLike,
  { tenantId, requestId, sessionId }: CompactionRequestOptions,
): CompactionRecord | null {
  const record = compactionRowsByRequest(db, tenantId, requestId).map(toRecord)[0] ?? null;
  if (record !== null && record.sessionId !== sessionId) throw otherSessionsRequest();
  return record;
}

function latestStarted(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  at: Date,
): CompactionRecord | null {
  return (
    latestStartedRows(db, {
      tenantId,
      sessionId,
      notAfter: at.toISOString(),
      notBefore: new Date(at.getTime() - REPLAY_AFTER_MS).toISOString(),
    }).map(toRecord)[0] ?? null
  );
}

interface MarkSummarizedOptions {
  readonly text: CompactionText;
  readonly summarizedAt: string;
  readonly requestId?: string;
}

export function markSummarized(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  options: MarkSummarizedOptions,
): boolean {
  const { text, summarizedAt, requestId } = options;
  return markCompactionSummarized(db, tenantId, id, {
    summary: text.summary,
    itemsJson: JSON.stringify(text.items),
    summarizedAt,
    requestId,
  });
}

/** On the caller's handle and tenant, so a server marks the record under the caller's tenant
 * with its own wait. */
export function markSnapshotSaved(db: DatabaseSyncLike, tenantId: string, recordId: string): void {
  markSnapshotSavedRow(db, tenantId, recordId);
}

interface SummaryCaller {
  originProject?: string;
  requestId?: string;
}

interface RecordSummaryOptions {
  readonly meta: Omit<CompactionStart, 'originProject'>;
  readonly text: CompactionText;
  readonly at: Date;
  readonly caller?: SummaryCaller;
}

/** Puts the summary on the session's `started` record, or inserts a `summarised` one when
 * pre-compact wrote none. One statement each. */
export function recordSummary(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  options: RecordSummaryOptions,
): CompactionRecord {
  const { meta, text, at, caller = {} } = options;
  const now = handleStamp(db);
  const itemsJson = JSON.stringify(text.items);
  const { requestId } = caller;
  const started = latestStarted(db, tenantId, meta.sessionId, at);
  if (started && markSummarized(db, tenantId, started.id, { text, summarizedAt: now, requestId })) {
    return {
      ...started,
      summary: text.summary,
      items: text.items,
      summarizedAt: now,
      status: 'summarised',
    };
  }
  const originProject = caller.originProject ?? compactionOrigin(files, meta.cwd);
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
  recordId: string | null;
  sessionId: string;
  originProject: string;
  cwd: string | null;
  items: string[];
  caller?: { actor: string; origins: readonly string[] };
}

interface Held {
  id: string | null;
  sessionId: string | null;
  words: string[];
}

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

interface CompactionEntryOptions {
  readonly text: string;
  readonly ctx: ItemContext;
  readonly origin: string | null;
  readonly baseHalfLifeDays: number;
  readonly now: Date;
}

function compactionEntry({
  text,
  ctx,
  origin,
  baseHalfLifeDays,
  now,
}: CompactionEntryOptions): MemoryEntry {
  return {
    ...createMemory(
      text,
      {
        layer: Layer.Episodic,
        tags: [COMPACTION_MEMORY_TAG],
        source: `${COMPACTION_SOURCE_PREFIX}${ctx.sessionId}`,
        confidence: 'observed',
        kind: 'distilled',
        sourceSessionId: ctx.sessionId,
        tenantId: ctx.tenantId,
        baseHalfLifeDays,
      },
      now,
    ),
    originProject: origin,
  };
}

interface WriteItemRowsOptions {
  readonly files: StoreFiles;
  readonly ctx: ItemContext;
  readonly rows: readonly string[];
  readonly baseHalfLifeDays: number;
}

function writeItemRows(
  db: DatabaseSyncLike,
  { files, ctx, rows, baseHalfLifeDays }: WriteItemRowsOptions,
): ItemWrites {
  const out: ItemWrites = { written: [], repeats: 0, refused: 0, restated: [] };
  const held = heldRows(
    db,
    ctx.tenantId,
    ctx.caller?.origins ?? heldOrigins(files, ctx.cwd, ctx.originProject),
  );
  const origin = ctx.caller === undefined ? itemOrigin(files, ctx) : ctx.originProject;
  const restated = new Set<string>();
  for (const text of rows) {
    const textWords = itemWords(text);
    const match = held.find((h) => restates(textWords, h.words));
    if (match) {
      out.repeats++;
      if (match.id !== null && match.sessionId !== ctx.sessionId) restated.add(match.id);
      continue;
    }
    if (text.trim().length < 3) {
      out.refused++;
      continue;
    }
    const entry = compactionEntry({ text, ctx, origin, baseHalfLifeDays, now: files.clock() });
    if (
      gatedWrite(db, files, entry, { actor: ctx.caller?.actor ?? 'post-compact' }) === 'written'
    ) {
      out.written.push(entry);
      held.push({ id: null, sessionId: ctx.sessionId, words: textWords });
    } else {
      out.refused++;
    }
  }
  out.restated = [...restated];
  return out;
}

function finishItemWrites(
  db: DatabaseSyncLike,
  files: StoreFiles,
  writes: ItemWrites,
  log: Log,
): void {
  if (writes.repeats > 0) log(`skipped ${writes.repeats} item(s) the store already holds`);
  if (writes.refused > 0) log(`skipped ${writes.refused} item(s) the write gate refused`);
  for (const entry of writes.written) writeEntryMirrors(files.hippoRoot, entry);
  if (writes.written.length > 0) {
    try {
      updateStats(db, files, { remembered: writes.written.length });
    } catch (err) {
      log('remembered counter not updated', err);
    }
  }
}

export interface SaveItemsOptions {
  readonly files: StoreFiles;
  readonly ctx: ItemContext;
  readonly log: Log;
  readonly baseHalfLifeDays: number;
}

/** Items that become rows, then the record `done`, in one transaction so two sessions cannot
 * both insert one text. Mirrors after commit. */
export function saveItems(
  db: DatabaseSyncLike,
  { files, ctx, log, baseHalfLifeDays }: SaveItemsOptions,
): number {
  const rows = writableItemRows(ctx.items, log);

  let finishedItems = 0;
  const writes = withWriteScopeOr<ItemWrites, null>(db, 'save_items', (rollback) => {
    if (ctx.recordId !== null) {
      const current = compactionProgress(db, ctx.tenantId, ctx.recordId);
      if (current?.status !== 'summarised') {
        finishedItems = current?.items_written ?? 0;
        return rollback(null);
      }
    }
    const written = writeItemRows(db, { files, ctx, rows, baseHalfLifeDays });
    const strengthen = {
      tenantId: ctx.tenantId,
      recallBoostAblated: !files.strength.recallStrengthens,
    };
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
  finishItemWrites(db, files, writes, log);
  return writes.written.length;
}
