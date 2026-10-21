// What turns a compaction's summary into text the store keeps, and the replay that reads the spool and transcripts
// for it; the SQL is the adapter's compactions-record.ts.
import * as fs from 'fs';
import { isObjectLike, isStringValue } from '../../base/session/capture-contract.js';
import {
  COMPACTION_ITEM_MAX_CHARS,
  compactSummaryBody,
  parseCompactionItems,
} from '../../base/util/compaction-items.js';
import { importSpool, spool, type Log, type SpooledCompaction } from './compaction-spool.js';
import type {
  CompactionHooks,
  CompactionSaveResult,
  CompactionText,
  ItemsOptions,
  OpenCompaction,
  StepFailure,
} from '../../store/port/compaction-hooks.js';
import type { StoreGroups } from '../../store/port.js';
import { loadConfig } from '../../base/config/config.js';
import { maskEmails, redactSecretsStrict } from '../../base/util/secret-detect.js';
import { errorFields, errorMessage, reportCompactionFailure } from '../../base/util/log.js';
import { readTranscriptTail, truncateCodePointSafe } from '../../base/util/transcript-tail.js';
import { type JsonValue, tryParseJson } from '../../base/util/json.js';

/** Tested verbatim: Claude Code hands PreCompact stdout to the summarizer as instructions. */
export const PRE_COMPACT_INSTRUCTION =
  "In your summary, add a last section titled 'Memories for hippo'. List, one per line starting with '- ', " +
  'each lesson learned, decision made (with its reason) and correction the user gave in this session that ' +
  'should outlive it. Write each as a standalone sentence that names its subject. Leave out anything an ' +
  "earlier summary already listed under 'Memories for hippo', and anything this session already saved with " +
  "`hippo remember`. Write '- none' if nothing new remains.";

/** A store folder, its store and the tenant a compaction hook writes as, which the CLI root resolved. */
export interface CompactionFolder {
  readonly root: string;
  readonly store: Pick<StoreGroups, 'compactionHooks'>;
  readonly tenantId: string;
}

const SUMMARY_MAX_CHARS = 256 * 1024;
const TRANSCRIPT_TAIL_CAPS = [1 << 20, 8 << 20, 64 << 20];

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
  return {
    summary: truncateCodePointSafe(scrub(body), SUMMARY_MAX_CHARS),
    items: parsed.items.map(scrub),
    found: parsed.found,
  };
}

/** A caller's items scrubbed as readCompactionText scrubs a summary's, since another machine's scrub is not trusted;
 * cut after it, as a mask can run longer than what it hides. */
export function scrubCompactionItems(items: readonly string[]): string[] {
  return items.map((item) => truncateCodePointSafe(scrub(item), COMPACTION_ITEM_MAX_CHARS));
}

export interface PostCompactPayload {
  sessionId: string;
  trigger: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  /** null when Claude Code sent none; the transcript fills the record later. */
  compactSummary: string | null;
}

interface SpoolSummaryOptions {
  folder: CompactionFolder;
  payload: PostCompactPayload;
  text: CompactionText;
  at: Date;
  reason: string;
  result: CompactionSaveResult;
  log: Log;
}

function spoolSummary(options: SpoolSummaryOptions): void {
  const { folder, payload, text, at, reason, result, log } = options;
  try {
    spool({ hippoRoot: folder.root, tenantId: folder.tenantId, payload, text, at });
    result.deferred = true;
    log(`store busy, summary spooled: ${reason}`);
  } catch (spoolErr) {
    reportCompactionFailure(log, 'spool', errorMessage(spoolErr), errorFields(spoolErr));
  }
}

function writeNotes(log: Log, notes: readonly string[]): void {
  for (const note of notes) log(note);
}

/** The PostCompact work: record the summary, then write its items. Each step is independent; a busy store spools or
 * defers. Never throws. */
export async function saveCompaction(
  folder: CompactionFolder,
  payload: PostCompactPayload,
  log: Log,
): Promise<CompactionSaveResult> {
  const { root, store, tenantId } = folder;
  const { compactSummary, ...meta } = payload;
  if (compactSummary === null) {
    log('skip: payload has no compact_summary');
    return { written: null, deferred: false, snapshotSaved: false };
  }
  const at = new Date();
  const { found, ...text } = readCompactionText(compactSummary);
  if (!found) log('no memories section');

  const { defaultHalfLifeDays } = loadConfig(root);
  const { result, spoolReason, notes } = await store.compactionHooks.save({
    tenantId,
    meta,
    text,
    at,
    baseHalfLifeDays: defaultHalfLifeDays,
  });
  writeNotes(log, notes);
  if (spoolReason !== null) spoolSummary({ folder, payload, text, at, reason: spoolReason, result, log });
  return result;
}

/** The one line PostCompact prints, or null when nothing was saved. */
export function postCompactLine(result: CompactionSaveResult): string | null {
  if (result.deferred) return 'Hippo will finish saving this compaction at the next sleep.';
  if (result.written === null) return null;
  if (result.written === 0) return "Hippo kept this compaction's summary; it listed no new memories.";
  const noun = result.written === 1 ? 'memory' : 'memories';
  const restored = result.snapshotSaved ? ' and restored your task snapshot' : '';
  return `Hippo saved ${result.written} ${noun} from this compaction${restored}.`;
}

interface TranscriptLine {
  isCompactSummary?: boolean;
  timestamp?: string;
  message?: { content?: string | Array<{ type?: string; text?: string }> };
}

// Every field is optional and read through a guard, so an object is all a line needs to be.
const isTranscriptLine = (value: JsonValue | undefined): value is JsonValue & TranscriptLine => isObjectLike(value);

function lineText(line: TranscriptLine): string {
  const content = line.message?.content;
  if (isStringValue(content)) return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (isStringValue(block.text) ? block.text : '')).join('\n');
}

/** The summary Claude Code wrote into a transcript between two moments; null when it is not (yet) there or the window
 * cannot reach back that far. */
function transcriptSummary(transcriptPath: string, afterMs: number, beforeMs: number): string | null {
  const size = fs.statSync(transcriptPath).size;
  for (const cap of TRANSCRIPT_TAIL_CAPS) {
    const lines: TranscriptLine[] = [];
    for (const raw of readTranscriptTail(transcriptPath, cap).split('\n')) {
      // The tail can start mid-line; a torn line holds no summary.
      const line = tryParseJson(raw);
      if (isTranscriptLine(line)) lines.push(line);
    }
    const stamp = (line: TranscriptLine): number =>
      isStringValue(line.timestamp) ? Date.parse(line.timestamp) : Number.NaN;
    const first = lines.map(stamp).find((ms) => !Number.isNaN(ms));
    const hit = lines.find((line) => line.isCompactSummary === true && stamp(line) > afterMs && stamp(line) < beforeMs);
    if (hit) return lineText(hit);
    if (size <= cap || (first !== undefined && first <= afterMs)) return null;
  }
  return null;
}

/** How long a replay waits on a locked store, and the Date.now() after which it starts no new record. */
export interface ReplayOptions {
  busyWaitMs?: number;
  deadline?: number;
}

/** What every replay step reads: the store's hooks, the folder its spool sits in, and the deadline the run works to. */
interface Replay {
  readonly hooks: CompactionHooks;
  readonly root: string;
  readonly tenantId: string;
  readonly log: Log;
  readonly deadline: number;
  readonly items: ItemsOptions;
}

async function replayStalled(run: Replay): Promise<number> {
  const { saved, notes } = await run.hooks.saveStalled(run.tenantId, { ...run.items, deadline: run.deadline });
  writeNotes(run.log, notes);
  return saved;
}

/** Records a spooled summary, then writes its items. */
async function importSpooled(
  run: Replay,
  spooled: SpooledCompaction,
  recorded: () => void,
): Promise<StepFailure | null> {
  const record = await run.hooks.recordSpooled(spooled, run.items);
  // The record holds the items now, so the file is done even if the write below fails.
  recorded();
  const saved = await run.hooks.saveRecordItems(spooled.tenantId, record, run.items);
  writeNotes(run.log, saved.notes);
  return saved.failure;
}

async function replaySpool(run: Replay): Promise<number> {
  try {
    return await importSpool({
      hippoRoot: run.root,
      tenantId: run.tenantId,
      log: run.log,
      deadline: run.deadline,
      importOne: (spooled, recorded) => importSpooled(run, spooled, recorded),
    });
  } catch (err) {
    run.log(`spool import failed: ${errorMessage(err)}`);
    return 0;
  }
}

/** Fills one open record from its transcript; true when it saved items. */
async function fillFromTranscript(run: Replay, record: OpenCompaction): Promise<boolean> {
  if (record.transcriptPath === null || !fs.existsSync(record.transcriptPath)) return false;
  const before = record.nextStartedAt === null ? Number.POSITIVE_INFINITY : Date.parse(record.nextStartedAt);
  const found = transcriptSummary(record.transcriptPath, Date.parse(record.startedAt), before);
  let text: CompactionText | null = null;
  if (found !== null) {
    const { found: listed, ...read } = readCompactionText(found);
    if (!listed) run.log(`no memories section in the transcript summary for ${record.id}`);
    text = read;
  }
  const filled = await run.hooks.fill(run.tenantId, record, text, run.items);
  writeNotes(run.log, filled.notes);
  return filled.saved;
}

/** A record whose fill throws is logged, and the rest still run until the deadline. */
async function replayOpen(run: Replay): Promise<number> {
  let saved = 0;
  for (const record of await run.hooks.openRecords(run.tenantId, run.items)) {
    if (Date.now() > run.deadline) break;
    try {
      if (await fillFromTranscript(run, record)) saved++;
    } catch (err) {
      run.log(`transcript fill of ${record.id} failed: ${errorMessage(err)}`);
    }
  }
  return saved;
}

/** For `hippo sleep` and post-compact: finishes what a killed hook or a busy store left (`summarised` records, spool
 * files, and `started` records the transcript can fill), never throws. Returns how many compactions it saved. */
export async function replayCompactions(
  { root, store, tenantId }: CompactionFolder,
  log: Log,
  opts: ReplayOptions = {},
): Promise<number> {
  const run: Replay = {
    hooks: store.compactionHooks,
    root,
    tenantId,
    log,
    deadline: opts.deadline ?? Number.POSITIVE_INFINITY,
    items: { busyWaitMs: opts.busyWaitMs, baseHalfLifeDays: loadConfig(root).defaultHalfLifeDays },
  };
  try {
    return (await replayStalled(run)) + (await replaySpool(run)) + (await replayOpen(run));
  } catch (err) {
    log(`replay failed: ${errorMessage(err)}`);
    return 0;
  }
}
