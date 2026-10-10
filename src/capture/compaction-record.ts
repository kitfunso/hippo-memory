// One record per Claude Code compaction, and what turns its summary into kept memories.
import * as fs from 'fs';
import * as path from 'path';
import { ConflictError } from '../core/api-errors.js';
import { isStringValue } from '../core/capture-contract.js';
import { COMPACTION_ITEM_MAX_CHARS, compactSummaryBody, parseCompactionItems, selectItemRows } from './compaction-items.js';
import { importSpool, spool, type SpoolImporter } from './compaction-spool.js';
import { isSharedStore, loadConfig } from '../core/config.js';
import { isSqliteBusy, withWriteScopeOr, type DatabaseSyncLike } from '../db/index.js';
import { withHandle } from '../store/open.js';
import { gatedWrite } from '../trust/gated-write.js';
import { COMPACTION_MEMORY_TAG, COMPACTION_SOURCE_PREFIX, Layer, createMemory, generateId, type MemoryEntry } from '../core/memory.js';
import { fallbackOrigin, isGlobalStoreRoot, projectId, projectNames, resolveProjectIdentity, type ProjectRef } from '../core/project-identity.js';
import { maskEmails, redactSecretsStrict } from '../util/secret-detect.js';
import {
  closeStartedWithoutSummary, compactionProgress, compactionRowsByRequest, heldMemoryRows, insertStartedCompaction, insertSummarisedCompaction,
  latestCompactionRows, latestStartedRows, markCompactionDone, markCompactionSummarised, markSnapshotSavedRow, nextCompactionStart, openTranscriptRows, stalledSummarisedRows,
  type CompactionRow, type CompactionStatus,
} from '../store/compactions.js';
import { strengthenRetrievedOn, writeEntryMirrors } from '../store/entry-writes.js';
import { isRecallBoostAblated } from '../core/ablation.js';
import { updateStats } from '../store/index-and-stats.js';
import { resolveTenantId } from '../store/tenant.js';
import { errorMessage, log as logger } from '../util/log.js';
import { readTranscriptTail, truncateCodePointSafe } from '../util/transcript-tail.js';

/** PostCompact has 10 s in all (PreCompact 30 s), so a locked store must be given up on early. */
export const COMPACTION_DB_WAIT_MS = 2000;

/** Tested verbatim: Claude Code hands PreCompact stdout to the summariser as instructions. */
export const PRE_COMPACT_INSTRUCTION =
  "In your summary, add a last section titled 'Memories for hippo'. List, one per line starting with '- ', each lesson learned, decision made (with its reason) and correction the user gave in this session that should outlive it. Write each as a standalone sentence that names its subject. Leave out anything an earlier summary already listed under 'Memories for hippo', and anything this session already saved with `hippo remember`. Write '- none' if nothing new remains.";

const SUMMARY_MAX_CHARS = 256 * 1024;
/** Long enough that a live hook has finished with its own record. */
export const REPLAY_AFTER_MS = 10 * 60_000;
/** Claude Code deletes transcripts after 30 days, so an older gap can never be filled. */
export const TRANSCRIPT_FILL_WINDOW_MS = 30 * 24 * 60 * 60_000;
const TRANSCRIPT_TAIL_CAPS = [1 << 20, 8 << 20, 64 << 20];
/** The marker redactSecretsStrict writes; an item holding it was a secret before it was stored. */
const REDACTED = '[REDACTED]';

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
  summarisedAt: string | null;
  summary: string | null;
  items: string[];
  itemsWritten: number;
  status: CompactionStatus;
}

export type Log = (message: string) => void;

/** Where the session ran: rows written through the global store or a shared store keep the project the session was in. */
function compactionProject(hippoRoot: string, cwd: string | null): ProjectRef {
  if (!isGlobalStoreRoot(hippoRoot) && !isSharedStore(hippoRoot)) return resolveProjectIdentity(path.dirname(hippoRoot));
  // No cwd means user-global, as stampOriginProject gives the global store; undefined would fall back to the hook's own cwd.
  return cwd === null ? '' : resolveProjectIdentity(cwd);
}

/** The record column cannot hold NULL, but an item from an unknown folder on a shared store must not read as user-global. */
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

function scrub(text: string): string {
  return maskEmails(redactSecretsStrict(text));
}

interface ScrubbedSummary {
  summary: string;
  items: string[];
  /** False when the summary has no memories section. */
  found: boolean;
}

/** What the record keeps of a compact_summary: the scrubbed body, and every parsed item scrubbed. */
export function readCompactionText(compactSummary: string): ScrubbedSummary {
  const body = compactSummaryBody(compactSummary);
  const parsed = parseCompactionItems(body);
  return { summary: truncateCodePointSafe(scrub(body), SUMMARY_MAX_CHARS), items: parsed.items.map(scrub), found: parsed.found };
}

/** A caller's items scrubbed as readCompactionText scrubs a summary's, since another machine's scrub is not trusted; cut after it, as a mask can run longer than what it hides. */
export function scrubCompactionItems(items: readonly string[]): string[] {
  return items.map((item) => truncateCodePointSafe(scrub(item), COMPACTION_ITEM_MAX_CHARS));
}

function toRecord(row: CompactionRow): CompactionRecord {
  const listed: unknown = row.items_json === null ? [] : JSON.parse(row.items_json);
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
    summarisedAt: row.summarised_at,
    summary: row.summary,
    items: Array.isArray(listed) ? listed.filter(isStringValue) : [],
    itemsWritten: row.items_written,
    status: row.status,
  };
}

export interface CompactionStart {
  sessionId: string;
  originProject: string;
  trigger: string | null;
  cwd: string | null;
  transcriptPath: string | null;
}

export function startCompaction(db: DatabaseSyncLike, tenantId: string, start: CompactionStart, at: Date = new Date()): string {
  const id = generateId('cmp');
  insertStartedCompaction(db, tenantId, { id, ...start, startedAt: at.toISOString() });
  return id;
}

/** A session's newest record, or null. */
export function latestCompaction(db: DatabaseSyncLike, tenantId: string, sessionId: string): CompactionRecord | null {
  return latestCompactionRows(db, tenantId, sessionId).map(toRecord)[0] ?? null;
}

/** The record a caller's request made, whatever state it reached, so a retry neither writes its items twice nor starts a second record; another session's id is a ConflictError. */
export function compactionByRequest(db: DatabaseSyncLike, tenantId: string, requestId: string, sessionId: string): CompactionRecord | null {
  const record = compactionRowsByRequest(db, tenantId, requestId).map(toRecord)[0] ?? null;
  // Sessions are owner-bound, so this also keeps one owner from reading or finishing another's record.
  if (record !== null && record.sessionId !== sessionId) throw new ConflictError('request id belongs to another session');
  return record;
}

/** Pre-compact's record for the compaction that is ending: the session's newest `started` one within REPLAY_AFTER_MS before `at`, so an older one is left for the transcript fill. */
function latestStarted(db: DatabaseSyncLike, tenantId: string, sessionId: string, at: Date): CompactionRecord | null {
  return latestStartedRows(db, tenantId, sessionId, at.toISOString(), new Date(at.getTime() - REPLAY_AFTER_MS).toISOString()).map(toRecord)[0] ?? null;
}

/** Moves a `started` record to `summarised`; false when another process already moved it. The request id lands in the same statement, so no crash leaves the record unfindable by its retry. */
interface MarkSummarisedOptions {
  readonly text: CompactionText;
  readonly summarisedAt: string;
  readonly requestId?: string;
}

function markSummarised(db: DatabaseSyncLike, tenantId: string, id: string, options: MarkSummarisedOptions): boolean {
  const { text, summarisedAt, requestId } = options;
  return markCompactionSummarised(db, tenantId, id, { summary: text.summary, itemsJson: JSON.stringify(text.items), summarisedAt, requestId });
}

/** Best effort, never throws: a compaction must not fail because its record could not be written. */
export function recordCompactionStart(hippoRoot: string, start: Omit<CompactionStart, 'originProject'>, log: Log): string | null {
  try {
    return withHandle(
      hippoRoot,
      (db) => startCompaction(db, resolveTenantId({}), { ...start, originProject: compactionOrigin(hippoRoot, start.cwd) }),
      { busyWaitMs: COMPACTION_DB_WAIT_MS },
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

export function recordSnapshotSaved(hippoRoot: string, tenantId: string, recordId: string, log: Log): void {
  try {
    withHandle(hippoRoot, (db) => markSnapshotSaved(db, tenantId, recordId), { busyWaitMs: COMPACTION_DB_WAIT_MS });
  } catch (err) {
    log(`compaction record not marked with its snapshot: ${errorMessage(err)}`);
  }
}

export interface CompactionText {
  summary: string;
  items: string[];
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

/** Puts the summary on the session's `started` record, or inserts a `summarised` one when pre-compact wrote none. One statement each. */
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
  if (started && markSummarised(db, tenantId, started.id, { text, summarisedAt: now, requestId })) {
    return { ...started, summary: text.summary, items: text.items, summarisedAt: now, status: 'summarised' };
  }
  const originProject = caller.originProject ?? compactionOrigin(hippoRoot, meta.cwd);
  const id = generateId('cmp');
  insertSummarisedCompaction(db, tenantId, { ...meta, originProject, startedAt: at.toISOString() }, { id, summary: text.summary, itemsJson, summarisedAt: now, requestId });
  return {
    id, tenantId, sessionId: meta.sessionId, originProject, trigger: meta.trigger, cwd: meta.cwd, transcriptPath: meta.transcriptPath,
    snapshotSaved: false, startedAt: at.toISOString(), summarisedAt: now, summary: text.summary, items: text.items, itemsWritten: 0, status: 'summarised',
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
  /** Set when another machine sent the items: its audit actor and its project's names, since the server's folder is neither. */
  caller?: { actor: string; origins: readonly string[] };
}

/** Words whose loss reverses or narrows a statement: "do not", "can't", "only", "unless". */
const PROTECTED_WORDS = new Set(['not', 'no', 'never', 'none', 'nor', 'without', 'cannot', 't', 'only', 'except', 'unless', 'until']);
/** Below this share of the held text's words, an item is a fragment of something longer, not a restatement. */
const RESTATE_MIN_SHARE = 0.5;

function words(text: string): string[] {
  return text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{M}\p{N}_]+/u).filter(Boolean);
}

/** True when `item` is `held` with words left out, in the same order, keeping every number and protected word. Spacing, case and punctuation may differ. */
function restates(item: readonly string[], held: readonly string[]): boolean {
  if (item.length === 0 || item.length < RESTATE_MIN_SHARE * held.length) return false;
  const kept = new Set(item);
  let next = 0;
  for (const w of held) {
    if (next < item.length && w === item[next]) next++;
    else if (!kept.has(w) && (PROTECTED_WORDS.has(w) || /\p{N}/u.test(w))) return false;
  }
  return next === item.length;
}

interface Held {
  /** null for a row this batch wrote, which needs no strengthening. */
  id: string | null;
  sessionId: string | null;
  words: string[];
}

/** Live rows of one tenant and origin that default recall shows: a compaction often restates what an earlier one, or the user, already saved. */
function heldRows(db: DatabaseSyncLike, tenantId: string, origins: readonly string[]): Held[] {
  return heldMemoryRows(db, tenantId, origins).map((r) => ({ id: r.id, sessionId: r.source_session_id, words: words(r.content) }));
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
      source_session_id: ctx.sessionId,
      tenantId: ctx.tenantId,
      baseHalfLifeDays,
    }),
    origin_project: origin,
  };
}

/** Runs inside saveItems' transaction: restatements of held rows are counted, the rest go through the write gate. */
function writeItemRows(db: DatabaseSyncLike, hippoRoot: string, ctx: ItemContext, rows: readonly string[], baseHalfLifeDays: number): ItemWrites {
  const out: ItemWrites = { written: [], repeats: 0, refused: 0, restated: [] };
  const held = heldRows(db, ctx.tenantId, ctx.caller?.origins ?? heldOrigins(hippoRoot, ctx.cwd, ctx.originProject));
  const origin = ctx.caller === undefined ? itemOrigin(hippoRoot, ctx) : ctx.originProject;
  const restated = new Set<string>();
  for (const text of rows) {
    const itemWords = words(text);
    const match = held.find((h) => restates(itemWords, h.words));
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
      held.push({ id: null, sessionId: ctx.sessionId, words: itemWords });
    } else {
      out.refused++;
    }
  }
  out.restated = [...restated];
  return out;
}

/** After commit: report skips, mirror the new rows, bump the counter. */
function finishItemWrites(hippoRoot: string, writes: ItemWrites, log: Log): void {
  if (writes.repeats > 0) log(`skipped ${writes.repeats} item(s) the store already holds`);
  if (writes.refused > 0) log(`skipped ${writes.refused} item(s) the write gate refused`);
  for (const entry of writes.written) writeEntryMirrors(hippoRoot, entry);
  if (writes.written.length > 0) {
    try {
      updateStats(hippoRoot, { remembered: writes.written.length });
    } catch (err) {
      // The rows are committed; a counter that could not be bumped must not turn that into a failed step.
      log(`remembered counter not updated: ${errorMessage(err)}`);
    }
  }
}

/** Items that become rows, then the record `done`, in one transaction so two sessions cannot both insert one text. Mirrors after commit. */
export function saveItems(db: DatabaseSyncLike, hippoRoot: string, ctx: ItemContext, log: Log): number {
  const usable = ctx.items.filter((item) => !item.includes(REDACTED));
  if (usable.length < ctx.items.length) log(`skipped ${ctx.items.length - usable.length} item(s) as secret`);
  const { rows, tooLong, capped } = selectItemRows(usable);
  if (tooLong > 0) log(`item too long: ${tooLong} kept in the record only`);
  if (capped > 0) log(`capped: ${capped} more kept in the record only`);

  const baseHalfLifeDays = loadConfig(hippoRoot).defaultHalfLifeDays;
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
    strengthenRetrievedOn(db, written.restated, { tenantId: ctx.tenantId, recallBoostAblated: isRecallBoostAblated() });
    if (ctx.recordId !== null) {
      markCompactionDone(db, ctx.tenantId, ctx.recordId, written.written.length);
    }
    return written;
  });
  if (writes === null) {
    log(`${ctx.recordId} was already finished by another process`);
    return finishedItems;
  }
  finishItemWrites(hippoRoot, writes, log);
  return writes.written.length;
}

export interface PostCompactPayload {
  sessionId: string;
  trigger: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  /** null when Claude Code sent none; the transcript fills the record later. */
  compactSummary: string | null;
}

export interface CompactionSaveResult {
  /** Memories written; null when neither the record nor the items could be saved. */
  written: number | null;
  /** True when the rest waits for the next sleep or post-compact. */
  deferred: boolean;
  snapshotSaved: boolean;
}

/** One failure, told once to the hook's output and once to the structured log. */
function reportFailure(log: Log, step: string, reason: string): void {
  log(`${step} failed: ${reason}`);
  logger.error(`post-compact: ${step} failed: ${reason}`);
}

interface SaveStep {
  db: DatabaseSyncLike;
  hippoRoot: string;
  tenantId: string;
  payload: PostCompactPayload;
  text: CompactionText;
  at: Date;
  result: CompactionSaveResult;
  log: Log;
}

function recordStep(step: SaveStep): CompactionRecord | null {
  try {
    const record = recordSummary(step.db, step.hippoRoot, step.tenantId, { meta: step.payload, text: step.text, at: step.at });
    step.result.snapshotSaved = record.snapshotSaved;
    return record;
  } catch (err) {
    if (isSqliteBusy(err)) throw err;
    reportFailure(step.log, 'record step', errorMessage(err));
    return null;
  }
}

/** Busy with a saved record defers to sleep; any other failure goes to the caller. */
function itemsStep(step: SaveStep, record: CompactionRecord | null): void {
  const { payload, hippoRoot, log } = step;
  try {
    step.result.written = saveItems(step.db, hippoRoot, {
      tenantId: step.tenantId,
      recordId: record?.id ?? null,
      sessionId: payload.sessionId,
      originProject: record?.originProject ?? compactionOrigin(hippoRoot, payload.cwd),
      cwd: payload.cwd,
      items: step.text.items,
    }, log);
  } catch (err) {
    if (!isSqliteBusy(err) || record === null) throw err;
    // The record already holds the items; sleep finishes them.
    step.result.deferred = true;
    log(`store busy, items left for the next sleep: ${errorMessage(err)}`);
  }
}

function spoolSummary(hippoRoot: string, payload: PostCompactPayload, text: CompactionText, at: Date, reason: string, result: CompactionSaveResult, log: Log): void {
  try {
    spool(hippoRoot, resolveTenantId({}), payload, text, at);
    result.deferred = true;
    log(`store busy, summary spooled: ${reason}`);
  } catch (spoolErr) {
    reportFailure(log, 'spool', errorMessage(spoolErr));
  }
}

/** The PostCompact work: record the summary, then write its items. Each step is independent; a busy store spools or defers. Never throws. */
export function saveCompaction(hippoRoot: string, payload: PostCompactPayload, log: Log): CompactionSaveResult {
  const result: CompactionSaveResult = { written: null, deferred: false, snapshotSaved: false };
  if (payload.compactSummary === null) {
    log('skip: payload has no compact_summary');
    return result;
  }
  const at = new Date();
  const { found, ...text } = readCompactionText(payload.compactSummary);
  if (!found) log('no memories section');

  let opened = false;
  try {
    withHandle(
      hippoRoot,
      (db) => {
        opened = true;
        const step: SaveStep = { db, hippoRoot, tenantId: resolveTenantId({}), payload, text, at, result, log };
        itemsStep(step, recordStep(step));
      },
      { busyWaitMs: COMPACTION_DB_WAIT_MS },
    );
  } catch (err) {
    if (isSqliteBusy(err) || !opened) spoolSummary(hippoRoot, payload, text, at, errorMessage(err), result, log);
    else reportFailure(log, 'items step', errorMessage(err));
  }
  return result;
}

/** The one line PostCompact prints, or null when nothing was saved. */
export function postCompactLine(result: CompactionSaveResult): string | null {
  if (result.deferred) return 'Hippo will finish saving this compaction at the next sleep.';
  if (result.written === null) return null;
  if (result.written === 0) return "Hippo kept this compaction's summary; it listed no new memories.";
  const noun = result.written === 1 ? 'memory' : 'memories';
  return `Hippo saved ${result.written} ${noun} from this compaction${result.snapshotSaved ? ' and restored your task snapshot' : ''}.`;
}

interface TranscriptLine {
  isCompactSummary?: boolean;
  timestamp?: string;
  message?: { content?: string | Array<{ type?: string; text?: string }> };
}

function lineText(line: TranscriptLine): string {
  const content = line.message?.content;
  if (isStringValue(content)) return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (isStringValue(block.text) ? block.text : '')).join('\n');
}

/** The summary Claude Code wrote into a transcript between two moments; null when it is not (yet) there or the window cannot reach back that far. */
function transcriptSummary(transcriptPath: string, afterMs: number, beforeMs: number): string | null {
  const size = fs.statSync(transcriptPath).size;
  for (const cap of TRANSCRIPT_TAIL_CAPS) {
    const lines: TranscriptLine[] = [];
    for (const raw of readTranscriptTail(transcriptPath, cap).split('\n')) {
      try {
        lines.push(JSON.parse(raw));
      } catch {
        continue; // the tail can start mid-line; a torn line holds no summary
      }
    }
    const stamp = (line: TranscriptLine): number => (isStringValue(line.timestamp) ? Date.parse(line.timestamp) : Number.NaN);
    const first = lines.map(stamp).find((ms) => !Number.isNaN(ms));
    const hit = lines.find((line) => line.isCompactSummary === true && stamp(line) > afterMs && stamp(line) < beforeMs);
    if (hit) return lineText(hit);
    if (size <= cap || (first !== undefined && first <= afterMs)) return null;
  }
  return null;
}

function closeWithoutSummary(db: DatabaseSyncLike, tenantId: string, id: string, log: Log): void {
  if (closeStartedWithoutSummary(db, tenantId, id) > 0) log(`${id} closed as no-summary: its transcript holds no summary for it`);
}

function nextStartedAt(db: DatabaseSyncLike, record: CompactionRecord): string | null {
  return nextCompactionStart(db, record.tenantId, record.sessionId, record.startedAt);
}

/** The one place a record becomes the argument saveItems takes. */
function itemContext(tenantId: string, record: CompactionRecord, items: string[] = record.items): ItemContext {
  return { tenantId, recordId: record.id, sessionId: record.sessionId, originProject: record.originProject, cwd: record.cwd, items };
}

/** Records a spooled summary, then writes its items. */
function spoolImporter(db: DatabaseSyncLike, hippoRoot: string, log: Log): SpoolImporter {
  return (spooled, recorded) => {
    const record = recordSummary(db, hippoRoot, spooled.tenantId, { meta: spooled.payload, text: spooled.text, at: spooled.at });
    // The record holds the items now, so the file is done even if the write below fails.
    recorded();
    saveItems(db, hippoRoot, itemContext(spooled.tenantId, record), log);
  };
}

function replayStalled(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, now: number, log: Log, deadline: number): number {
  let finished = 0;
  const stalled = stalledSummarisedRows(db, tenantId, new Date(now - REPLAY_AFTER_MS).toISOString()).map(toRecord);
  for (const record of stalled) {
    if (Date.now() > deadline) break;
    try {
      saveItems(db, hippoRoot, itemContext(tenantId, record), log);
      finished++;
    } catch (err) {
      log(`replay of ${record.id} failed: ${errorMessage(err)}`);
    }
  }
  return finished;
}

function replaySpool(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, log: Log, deadline: number): number {
  try {
    return importSpool(hippoRoot, tenantId, log, deadline, spoolImporter(db, hippoRoot, log));
  } catch (err) {
    log(`spool import failed: ${errorMessage(err)}`);
    return 0;
  }
}

/** Fills one open record from its transcript; true when it saved items. */
function fillFromTranscript(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, record: CompactionRecord, log: Log): boolean {
  if (record.transcriptPath === null || !fs.existsSync(record.transcriptPath)) return false;
  const next = nextStartedAt(db, record);
  const found = transcriptSummary(record.transcriptPath, Date.parse(record.startedAt), next === null ? Number.POSITIVE_INFINITY : Date.parse(next));
  if (found === null) {
    // The record is past REPLAY_AFTER_MS, so a window that is fully scanned or out of reach stays empty.
    closeWithoutSummary(db, tenantId, record.id, log);
    return false;
  }
  const { found: listed, ...text } = readCompactionText(found);
  if (!listed) log(`no memories section in the transcript summary for ${record.id}`);
  if (!markSummarised(db, tenantId, record.id, { text, summarisedAt: new Date().toISOString() })) {
    log(`${record.id} was filled by another process`);
    return false;
  }
  saveItems(db, hippoRoot, itemContext(tenantId, record, text.items), log);
  return true;
}

function replayOpen(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, now: number, log: Log, deadline: number): number {
  let finished = 0;
  const open = openTranscriptRows(
    db,
    tenantId,
    new Date(now - REPLAY_AFTER_MS).toISOString(),
    new Date(now - TRANSCRIPT_FILL_WINDOW_MS).toISOString(),
  ).map(toRecord);
  for (const record of open) {
    if (Date.now() > deadline) break;
    try {
      if (fillFromTranscript(db, hippoRoot, tenantId, record, log)) finished++;
    } catch (err) {
      log(`transcript fill of ${record.id} failed: ${errorMessage(err)}`);
    }
  }
  return finished;
}

/** Finishes what a killed hook or a busy store left: `summarised` records, spool files, and `started` records the transcript can fill. Returns how many compactions it saved. */
export function replayCompactions(db: DatabaseSyncLike, hippoRoot: string, log: Log, deadline: number = Number.POSITIVE_INFINITY): number {
  const tenantId = resolveTenantId({});
  const now = Date.now();
  return replayStalled(db, hippoRoot, tenantId, now, log, deadline)
    + replaySpool(db, hippoRoot, tenantId, log, deadline)
    + replayOpen(db, hippoRoot, tenantId, now, log, deadline);
}

/** For `hippo sleep` and post-compact: opens the store itself and never throws. */
export function replayCompactionsAt(hippoRoot: string, log: Log, opts: { busyWaitMs?: number; deadline?: number } = {}): number {
  try {
    return withHandle(hippoRoot, (db) => replayCompactions(db, hippoRoot, log, opts.deadline), { busyWaitMs: opts.busyWaitMs });
  } catch (err) {
    log(`replay failed: ${errorMessage(err)}`);
    return 0;
  }
}
