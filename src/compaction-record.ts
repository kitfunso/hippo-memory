// One record per Claude Code compaction, and what turns its summary into kept memories.
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage, readTranscriptTail, truncateCodePointSafe } from './capture.js';
import { isObjectLike, isStringValue } from './capture-contract.js';
import { compactSummaryBody, parseCompactionItems, selectItemRows } from './compaction-items.js';
import { loadConfig } from './config.js';
import { closeHippoDb, isSqliteBusy, openHippoDb, type DatabaseSyncLike } from './db.js';
import { gatedWrite } from './gated-write.js';
import { COMPACTION_MEMORY_TAG, COMPACTION_SOURCE_PREFIX, Layer, createMemory, generateId, type MemoryEntry } from './memory.js';
import { deriveOriginProject, isGlobalStoreRoot } from './project-identity.js';
import { maskEmails, redactSecretsStrict } from './secret-detect.js';
import { strengthenRetrievedOn, updateStats, writeEntryMirrors } from './store.js';
import { resolveTenantId } from './tenant.js';

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
const SPOOL_DIR = 'compactions-spool';
const CLAIMED_SUFFIX = '.claimed';
/** The marker redactSecretsStrict writes; an item holding it was a secret before it was stored. */
const REDACTED = '[REDACTED]';

export type CompactionStatus = 'started' | 'summarised' | 'done' | 'no-summary';

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

interface CompactionRow {
  tenant_id: string;
  id: string;
  session_id: string;
  origin_project: string;
  compact_trigger: string | null;
  cwd: string | null;
  transcript_path: string | null;
  snapshot_saved: number;
  started_at: string;
  summarised_at: string | null;
  summary: string | null;
  items_json: string | null;
  items_written: number;
  status: CompactionStatus;
}

export type Log = (message: string) => void;

/** Where the session ran: rows written through the global store keep the project the session was in. */
export function compactionOrigin(hippoRoot: string, cwd: string | null): string {
  if (!isGlobalStoreRoot(hippoRoot)) return deriveOriginProject(path.dirname(hippoRoot));
  // No cwd means user-global, as stampOriginProject gives the global store; undefined would fall back to the hook's own cwd.
  return cwd === null ? '' : deriveOriginProject(cwd);
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

const COLUMNS = 'tenant_id, id, session_id, origin_project, compact_trigger, cwd, transcript_path, snapshot_saved, started_at, summarised_at, summary, items_json, items_written, status';

function selectRecords(db: DatabaseSyncLike, where: string, ...params: Array<string | number>): CompactionRecord[] {
  // SAFETY: the SELECT names exactly COLUMNS, matching CompactionRow's field set.
  const rows = db.prepare(`SELECT ${COLUMNS} FROM compactions WHERE ${where}`).all(...params) as CompactionRow[];
  return rows.map(toRecord);
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
  db.prepare(
    `INSERT INTO compactions(tenant_id, id, session_id, origin_project, compact_trigger, cwd, transcript_path, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(tenantId, id, start.sessionId, start.originProject, start.trigger, start.cwd, start.transcriptPath, at.toISOString());
  return id;
}

/** A session's newest record, or null. */
export function latestCompaction(db: DatabaseSyncLike, tenantId: string, sessionId: string): CompactionRecord | null {
  return selectRecords(db, 'tenant_id = ? AND session_id = ? ORDER BY started_at DESC, id DESC LIMIT 1', tenantId, sessionId)[0] ?? null;
}

/** Pre-compact's record for the compaction that is ending: the session's newest `started` one within REPLAY_AFTER_MS before `at`, so an older one is left for the transcript fill. */
function latestStarted(db: DatabaseSyncLike, tenantId: string, sessionId: string, at: Date): CompactionRecord | null {
  return selectRecords(
    db,
    `tenant_id = ? AND session_id = ? AND status = 'started' AND started_at <= ? AND started_at >= ? ORDER BY started_at DESC, id DESC LIMIT 1`,
    tenantId,
    sessionId,
    at.toISOString(),
    new Date(at.getTime() - REPLAY_AFTER_MS).toISOString(),
  )[0] ?? null;
}

/** Moves a `started` record to `summarised`; false when another process already moved it. */
function markSummarised(db: DatabaseSyncLike, tenantId: string, id: string, text: CompactionText, summarisedAt: string): boolean {
  const result = db.prepare(
    `UPDATE compactions SET summary = ?, items_json = ?, summarised_at = ?, status = 'summarised' WHERE tenant_id = ? AND id = ? AND status = 'started'`,
  ).run(text.summary, JSON.stringify(text.items), summarisedAt, tenantId, id);
  return (result.changes ?? 0) > 0;
}

/** Best effort, never throws: a compaction must not fail because its record could not be written. */
export function recordCompactionStart(hippoRoot: string, start: Omit<CompactionStart, 'originProject'>, log: Log): string | null {
  let db: DatabaseSyncLike | undefined;
  try {
    db = openHippoDb(hippoRoot, { busyWaitMs: COMPACTION_DB_WAIT_MS });
    return startCompaction(db, resolveTenantId({}), { ...start, originProject: compactionOrigin(hippoRoot, start.cwd) });
  } catch (err) {
    log(`compaction record not started: ${errorMessage(err)}`);
    return null;
  } finally {
    if (db) closeHippoDb(db);
  }
}

export function recordSnapshotSaved(hippoRoot: string, recordId: string, log: Log): void {
  let db: DatabaseSyncLike | undefined;
  try {
    db = openHippoDb(hippoRoot, { busyWaitMs: COMPACTION_DB_WAIT_MS });
    db.prepare(`UPDATE compactions SET snapshot_saved = 1 WHERE tenant_id = ? AND id = ?`).run(resolveTenantId({}), recordId);
  } catch (err) {
    log(`compaction record not marked with its snapshot: ${errorMessage(err)}`);
  } finally {
    if (db) closeHippoDb(db);
  }
}

export interface CompactionText {
  summary: string;
  items: string[];
}

/** Puts the summary on the session's `started` record, or inserts a `summarised` one when pre-compact wrote none. One statement each. */
function recordSummary(
  db: DatabaseSyncLike,
  hippoRoot: string,
  tenantId: string,
  meta: Omit<CompactionStart, 'originProject'>,
  text: CompactionText,
  at: Date,
): CompactionRecord {
  const now = new Date().toISOString();
  const itemsJson = JSON.stringify(text.items);
  const started = latestStarted(db, tenantId, meta.sessionId, at);
  if (started && markSummarised(db, tenantId, started.id, text, now)) {
    return { ...started, summary: text.summary, items: text.items, summarisedAt: now, status: 'summarised' };
  }
  const originProject = compactionOrigin(hippoRoot, meta.cwd);
  const id = generateId('cmp');
  db.prepare(
    `INSERT INTO compactions(tenant_id, id, session_id, origin_project, compact_trigger, cwd, transcript_path, started_at, summarised_at, summary, items_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'summarised')`,
  ).run(tenantId, id, meta.sessionId, originProject, meta.trigger, meta.cwd, meta.transcriptPath, at.toISOString(), now, text.summary, itemsJson);
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
  items: string[];
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
function heldRows(db: DatabaseSyncLike, tenantId: string, originProject: string): Held[] {
  // SAFETY: the SELECT names the id, source_session_id and content columns.
  const rows = db.prepare(
    `SELECT id, source_session_id, content FROM memories WHERE tenant_id = ? AND origin_project = ? AND superseded_by IS NULL AND kind != 'raw'
       AND (scope IS NULL OR (scope != 'unknown:legacy' AND scope NOT LIKE '%:private:%'))`,
  ).all(tenantId, originProject) as Array<{ id: string; source_session_id: string | null; content: string }>;
  return rows.map((r) => ({ id: r.id, sessionId: r.source_session_id, words: words(r.content) }));
}

/** Items that become rows, then the record `done`, in one transaction so two sessions cannot both insert one text. Mirrors after commit. */
export function saveItems(db: DatabaseSyncLike, hippoRoot: string, ctx: ItemContext, log: Log): number {
  const usable = ctx.items.filter((item) => !item.includes(REDACTED));
  if (usable.length < ctx.items.length) log(`skipped ${ctx.items.length - usable.length} item(s) as secret`);
  const { rows, tooLong, capped } = selectItemRows(usable);
  if (tooLong > 0) log(`item too long: ${tooLong} kept in the record only`);
  if (capped > 0) log(`capped: ${capped} more kept in the record only`);

  const baseHalfLifeDays = loadConfig(hippoRoot).defaultHalfLifeDays;
  const written: MemoryEntry[] = [];
  let repeats = 0;
  let refused = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (ctx.recordId !== null) {
      // A replayer that read the record before another finished it must not write its items again.
      const current = db.prepare(`SELECT status, items_written FROM compactions WHERE tenant_id = ? AND id = ?`)
        .get<{ status: CompactionStatus; items_written: number } | undefined>(ctx.tenantId, ctx.recordId);
      if (current?.status !== 'summarised') {
        db.exec('ROLLBACK');
        log(`${ctx.recordId} was already finished by another process`);
        return current?.items_written ?? 0;
      }
    }
    const held = heldRows(db, ctx.tenantId, ctx.originProject);
    const restated = new Set<string>();
    for (const text of rows) {
      const itemWords = words(text);
      const match = held.find((h) => restates(itemWords, h.words));
      if (match) {
        repeats++;
        if (match.id !== null && match.sessionId !== ctx.sessionId) restated.add(match.id);
        continue;
      }
      // createMemory throws below 3 chars, which would sink the whole transaction.
      if (text.trim().length < 3) {
        refused++;
        continue;
      }
      const entry: MemoryEntry = {
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
        origin_project: ctx.originProject,
      };
      if (gatedWrite(db, hippoRoot, entry, { actor: 'post-compact' }) === 'written') {
        written.push(entry);
        held.push({ id: null, sessionId: ctx.sessionId, words: itemWords });
      } else {
        refused++;
      }
    }
    // Said again by another session is the same signal as being recalled; the same session carrying it forward is not.
    strengthenRetrievedOn(db, [...restated], ctx.tenantId);
    if (ctx.recordId !== null) {
      db.prepare(`UPDATE compactions SET items_written = ?, status = 'done' WHERE tenant_id = ? AND id = ?`).run(written.length, ctx.tenantId, ctx.recordId);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back; keep the original error */ }
    throw err;
  }
  if (repeats > 0) log(`skipped ${repeats} item(s) the store already holds`);
  if (refused > 0) log(`skipped ${refused} item(s) the write gate refused`);
  for (const entry of written) writeEntryMirrors(hippoRoot, entry);
  if (written.length > 0) {
    try {
      updateStats(hippoRoot, { remembered: written.length });
    } catch (err) {
      // The rows are committed; a counter that could not be bumped must not turn that into a failed step.
      log(`remembered counter not updated: ${errorMessage(err)}`);
    }
  }
  return written.length;
}

export interface PostCompactPayload {
  sessionId: string;
  trigger: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  /** null when Claude Code sent none; the transcript fills the record later. */
  compactSummary: string | null;
}

/** null when the text is not a PostCompact payload naming a session. */
export function parsePostCompactPayload(stdinText: string | undefined): PostCompactPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse((stdinText ?? '').trim());
  } catch {
    return null;
  }
  if (!isObjectLike(raw) || !('session_id' in raw) || !isStringValue(raw.session_id) || raw.session_id === '') return null;
  return {
    sessionId: raw.session_id,
    trigger: 'trigger' in raw && isStringValue(raw.trigger) ? raw.trigger : null,
    cwd: 'cwd' in raw && isStringValue(raw.cwd) ? raw.cwd : null,
    transcriptPath: 'transcript_path' in raw && isStringValue(raw.transcript_path) ? raw.transcript_path : null,
    compactSummary: 'compact_summary' in raw && isStringValue(raw.compact_summary) ? raw.compact_summary : null,
  };
}

export interface CompactionSaveResult {
  /** Memories written; null when neither the record nor the items could be saved. */
  written: number | null;
  /** True when the rest waits for the next sleep or post-compact. */
  deferred: boolean;
  snapshotSaved: boolean;
}

function spoolFile(hippoRoot: string, sessionId: string): string {
  return path.join(hippoRoot, SPOOL_DIR, `${sessionId.replace(/[^\w-]/g, '_').slice(0, 80)}-${Date.now()}.json`);
}

function spool(hippoRoot: string, tenantId: string, payload: PostCompactPayload, text: CompactionText, at: Date): void {
  const file = spoolFile(hippoRoot, payload.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { tenantId, sessionId: payload.sessionId, trigger: payload.trigger, cwd: payload.cwd, transcriptPath: payload.transcriptPath, at: at.toISOString(), summary: text.summary, items: text.items };
  // Renamed into place so a replayer listing `.json` files never reads half a file.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(body), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
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

  let db: DatabaseSyncLike | undefined;
  try {
    db = openHippoDb(hippoRoot, { busyWaitMs: COMPACTION_DB_WAIT_MS });
    const tenantId = resolveTenantId({});
    let record: CompactionRecord | null = null;
    try {
      record = recordSummary(db, hippoRoot, tenantId, payload, text, at);
      result.snapshotSaved = record.snapshotSaved;
    } catch (err) {
      if (isSqliteBusy(err)) throw err;
      log(`record step failed: ${errorMessage(err)}`);
      console.error(`hippo post-compact: record step failed: ${errorMessage(err)}`);
    }
    try {
      result.written = saveItems(db, hippoRoot, {
        tenantId,
        recordId: record?.id ?? null,
        sessionId: payload.sessionId,
        originProject: record?.originProject ?? compactionOrigin(hippoRoot, payload.cwd),
        items: text.items,
      }, log);
    } catch (err) {
      if (!isSqliteBusy(err) || record === null) throw err;
      // The record already holds the items; sleep finishes them.
      result.deferred = true;
      log(`store busy, items left for the next sleep: ${errorMessage(err)}`);
    }
  } catch (err) {
    if (isSqliteBusy(err) || db === undefined) {
      try {
        spool(hippoRoot, resolveTenantId({}), payload, text, at);
        result.deferred = true;
        log(`store busy, summary spooled: ${errorMessage(err)}`);
      } catch (spoolErr) {
        log(`spool failed: ${errorMessage(spoolErr)}`);
        console.error(`hippo post-compact: spool failed: ${errorMessage(spoolErr)}`);
      }
    } else {
      log(`items step failed: ${errorMessage(err)}`);
      console.error(`hippo post-compact: items step failed: ${errorMessage(err)}`);
    }
  } finally {
    if (db) closeHippoDb(db);
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
        continue;
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
  const result = db.prepare(`UPDATE compactions SET status = 'no-summary' WHERE tenant_id = ? AND id = ? AND status = 'started'`).run(tenantId, id);
  if ((result.changes ?? 0) > 0) log(`${id} closed as no-summary: its transcript holds no summary for it`);
}

function nextStartedAt(db: DatabaseSyncLike, record: CompactionRecord): string | null {
  const row = db.prepare(`SELECT MIN(started_at) AS at FROM compactions WHERE tenant_id = ? AND session_id = ? AND started_at > ?`)
    .get<{ at: string | null } | undefined>(record.tenantId, record.sessionId, record.startedAt);
  return row?.at ?? null;
}

interface SpooledCompaction {
  tenantId: string;
  payload: PostCompactPayload;
  text: CompactionText;
  at: Date;
}

function readSpooled(file: string, fallbackTenantId: string): SpooledCompaction | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isObjectLike(raw) || !('sessionId' in raw) || !isStringValue(raw.sessionId) || !('summary' in raw) || !isStringValue(raw.summary)) return null;
  if (!('at' in raw) || !isStringValue(raw.at) || Number.isNaN(Date.parse(raw.at))) return null;
  const items: string[] = 'items' in raw && Array.isArray(raw.items) ? raw.items.filter(isStringValue) : [];
  return {
    tenantId: 'tenantId' in raw && isStringValue(raw.tenantId) && raw.tenantId !== '' ? raw.tenantId : fallbackTenantId,
    payload: {
      sessionId: raw.sessionId,
      trigger: 'trigger' in raw && isStringValue(raw.trigger) ? raw.trigger : null,
      cwd: 'cwd' in raw && isStringValue(raw.cwd) ? raw.cwd : null,
      transcriptPath: 'transcriptPath' in raw && isStringValue(raw.transcriptPath) ? raw.transcriptPath : null,
      compactSummary: null,
    },
    text: { summary: raw.summary, items },
    at: new Date(raw.at),
  };
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/** A live replayer refreshes its claim's mtime when it takes it, so an old claim means the replayer died. */
function recoverStaleClaims(dir: string, log: Log): void {
  const staleBefore = Date.now() - REPLAY_AFTER_MS;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(`.json${CLAIMED_SUFFIX}`))) {
    const claimed = path.join(dir, name);
    try {
      if (fs.statSync(claimed).mtimeMs >= staleBefore) continue;
      fs.renameSync(claimed, claimed.slice(0, -CLAIMED_SUFFIX.length));
      log(`spool file ${name} was claimed by a replayer that never finished, put back`);
    } catch (err) {
      if (!isMissingFile(err)) log(`spool file ${name} not recovered: ${errorMessage(err)}`);
    }
  }
}

function releaseClaim(claimed: string, file: string, log: Log): void {
  try {
    fs.renameSync(claimed, file);
  } catch (err) {
    log(`spool file ${path.basename(file)} could not be put back: ${errorMessage(err)}`);
  }
}

/** Each file is claimed by rename before it is read, so two replayers never import the same one. */
function importSpool(db: DatabaseSyncLike, hippoRoot: string, tenantId: string, log: Log, deadline: number): number {
  const dir = path.join(hippoRoot, SPOOL_DIR);
  if (!fs.existsSync(dir)) return 0;
  recoverStaleClaims(dir, log);
  let finished = 0;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    if (Date.now() > deadline) break;
    const file = path.join(dir, name);
    const claimed = `${file}${CLAIMED_SUFFIX}`;
    try {
      fs.renameSync(file, claimed);
      const now = new Date();
      fs.utimesSync(claimed, now, now);
    } catch (err) {
      if (!isMissingFile(err)) log(`spool file ${name} not claimed: ${errorMessage(err)}`);
      continue;
    }
    const spooled = readSpooled(claimed, tenantId);
    if (!spooled) {
      log(`spool file ${name} is not readable, set aside`);
      fs.renameSync(claimed, `${file}.bad`);
      continue;
    }
    let removed = false;
    try {
      const record = recordSummary(db, hippoRoot, spooled.tenantId, spooled.payload, spooled.text, spooled.at);
      // The record holds the items now, so the file is done even if the write below fails.
      fs.rmSync(claimed, { force: true });
      removed = true;
      saveItems(db, hippoRoot, { tenantId: spooled.tenantId, recordId: record.id, sessionId: record.sessionId, originProject: record.originProject, items: record.items }, log);
      finished++;
    } catch (err) {
      log(`spool file ${name} not imported: ${errorMessage(err)}`);
      if (!removed) releaseClaim(claimed, file, log);
    }
  }
  return finished;
}

/** Finishes what a killed hook or a busy store left: `summarised` records, spool files, and `started` records the transcript can fill. Returns how many compactions it saved. */
export function replayCompactions(db: DatabaseSyncLike, hippoRoot: string, log: Log, deadline: number = Number.POSITIVE_INFINITY): number {
  const tenantId = resolveTenantId({});
  const now = Date.now();
  let finished = 0;

  const stalled = selectRecords(db, `tenant_id = ? AND status = 'summarised' AND summarised_at < ?`, tenantId, new Date(now - REPLAY_AFTER_MS).toISOString());
  for (const record of stalled) {
    if (Date.now() > deadline) break;
    try {
      saveItems(db, hippoRoot, { tenantId, recordId: record.id, sessionId: record.sessionId, originProject: record.originProject, items: record.items }, log);
      finished++;
    } catch (err) {
      log(`replay of ${record.id} failed: ${errorMessage(err)}`);
    }
  }

  try {
    finished += importSpool(db, hippoRoot, tenantId, log, deadline);
  } catch (err) {
    log(`spool import failed: ${errorMessage(err)}`);
  }

  const open = selectRecords(
    db,
    `tenant_id = ? AND status = 'started' AND started_at < ? AND started_at > ? AND transcript_path IS NOT NULL ORDER BY started_at`,
    tenantId,
    new Date(now - REPLAY_AFTER_MS).toISOString(),
    new Date(now - TRANSCRIPT_FILL_WINDOW_MS).toISOString(),
  );
  for (const record of open) {
    if (Date.now() > deadline) break;
    try {
      if (record.transcriptPath === null || !fs.existsSync(record.transcriptPath)) continue;
      const next = nextStartedAt(db, record);
      const found = transcriptSummary(record.transcriptPath, Date.parse(record.startedAt), next === null ? Number.POSITIVE_INFINITY : Date.parse(next));
      if (found === null) {
        // The record is past REPLAY_AFTER_MS, so a window that is fully scanned or out of reach stays empty.
        closeWithoutSummary(db, tenantId, record.id, log);
        continue;
      }
      const { found: listed, ...text } = readCompactionText(found);
      if (!listed) log(`no memories section in the transcript summary for ${record.id}`);
      if (!markSummarised(db, tenantId, record.id, text, new Date().toISOString())) {
        log(`${record.id} was filled by another process`);
        continue;
      }
      saveItems(db, hippoRoot, { tenantId, recordId: record.id, sessionId: record.sessionId, originProject: record.originProject, items: text.items }, log);
      finished++;
    } catch (err) {
      log(`transcript fill of ${record.id} failed: ${errorMessage(err)}`);
    }
  }
  return finished;
}

/** For `hippo sleep` and post-compact: opens the store itself and never throws. */
export function replayCompactionsAt(hippoRoot: string, log: Log, opts: { busyWaitMs?: number; deadline?: number } = {}): number {
  let db: DatabaseSyncLike | undefined;
  try {
    db = openHippoDb(hippoRoot, { busyWaitMs: opts.busyWaitMs });
    return replayCompactions(db, hippoRoot, log, opts.deadline);
  } catch (err) {
    log(`replay failed: ${errorMessage(err)}`);
    return 0;
  } finally {
    if (db) closeHippoDb(db);
  }
}
