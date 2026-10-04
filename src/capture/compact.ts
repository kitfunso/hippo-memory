import * as fs from 'fs';
import * as path from 'path';
import { type TaskSnapshot } from '../store/rows.js';
import { isInitialized } from '../store/open.js';
import { saveActiveTaskSnapshot, loadActiveTaskSnapshot } from '../store/sessions.js';
import {
  PRE_COMPACT_INSTRUCTION,
  parsePostCompactPayload,
  postCompactLine,
  recordCompactionStart,
  recordSnapshotSaved,
  saveCompaction,
  replayCompactionsAt,
  COMPACTION_DB_WAIT_MS,
} from '../compaction-record.js';
import { resolveTenantId } from '../tenant.js';
import { defaultPreCompactLogPath } from '../hooks/shared.js';
import { maskEmails, redactSecretsStrict } from '../secret-detect.js';
import { isObjectLike, isStringValue, readClaudeCodePreCompact } from '../capture-contract.js';
import { errorMessage } from '../log.js';
import { PRE_COMPACT_TAIL_BYTES, readTranscriptTail, truncateCodePointSafe } from '../transcript-tail.js';
import { humanUserText, summariseTranscript, resolveLastSessionTranscript } from './transcript.js';

// ---------------------------------------------------------------------------
// `hippo pre-compact` — PreCompact hook producer
// ---------------------------------------------------------------------------

export const PRE_COMPACT_TASK_CAP = 200;
export const PRE_COMPACT_SUMMARY_CAP = 2000;
export const PRE_COMPACT_NEXT_STEP_CAP = 500;

/**
 * Cap from the RECENT end: summariseTranscript emits user turns oldest-to-
 * newest with assistant responses after them, so a head-first cap keeps
 * stale context and drops exactly the newest working state this feature
 * exists to preserve. Keep the LAST maxChars instead, aligned forward to a
 * nearby line start, with a trim marker (codex round 3).
 */
export function truncateKeepNewest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let start = text.length - maxChars;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // never start on a low surrogate
  const nl = text.indexOf('\n', start);
  if (nl !== -1 && nl + 1 < text.length && nl - start < 200) start = nl + 1;
  return '[...earlier turns trimmed]\n' + text.slice(start);
}

/** Most recent plain-text user message in a JSONL tail. Claude Code transcript shape only (PreCompact is claude-code-only). */
function lastPlainUserMessage(jsonl: string): string {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // the tail read can start mid-line; skip the torn fragment
    }
    if (!isObjectLike(entry)) continue;
    if (!('type' in entry) || entry.type !== 'user') continue;
    // Meta/sidechain lines carry type:'user' but are not the human: after a
    // FIRST compaction the transcript holds the compact summary as an isMeta
    // user line, and sub-agent turns are isSidechain — deriving "task" from
    // either yields junk on every later compaction.
    if (('isMeta' in entry && entry.isMeta === true) || ('isSidechain' in entry && entry.isSidechain === true)) continue;
    const message = 'message' in entry && isObjectLike(entry.message) ? entry.message : undefined;
    if (!message) continue;
    const text = humanUserText(entry, message);
    if (text) return text;
  }
  return '';
}

/** Last assistant text block in a JSONL tail (skips thinking + tool_use, same as summariseTranscript). */
function lastAssistantTextBlock(jsonl: string): string {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // the tail read can start mid-line; skip the torn fragment
    }
    if (!isObjectLike(entry)) continue;
    if (!('type' in entry) || entry.type !== 'assistant') continue;
    // Same meta/sidechain guard as lastPlainUserMessage: sub-agent turns
    // (isSidechain) are not this session's next step.
    if (('isMeta' in entry && entry.isMeta === true) || ('isSidechain' in entry && entry.isSidechain === true)) continue;
    const message = 'message' in entry && isObjectLike(entry.message) ? entry.message : undefined;
    if (!message) continue;
    const content = 'content' in message ? message.content : undefined;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (isObjectLike(block)) {
        const blockText = 'type' in block && block.type === 'text' && 'text' in block ? block.text : undefined;
        if (isStringValue(blockText) && blockText.trim()) {
          return blockText.trim();
        }
      }
    }
  }
  return '';
}

// Diagnostic-only log; a long-lived install must not grow it unbounded.
const PRE_COMPACT_LOG_MAX_BYTES = 256 * 1024;

/**
 * Log-forgery guard: messages here interpolate payload-controlled values
 * (transcript paths, session ids). Strip C0 control chars — newlines above
 * all — so a crafted value can't inject fake `[hippo] ...` log lines.
 * Exported for every `[hippo]`-prefixed log writer that interpolates
 * payload-controlled values (cli.ts appendSessionEndCloseLog) — one shared
 * guard, not per-file copies.
 */
export function sanitizeLogMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\x00-\x1f]/g, '');
}

function appendPreCompactLog(logFile: string, message: string): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
    if (stat && stat.size > PRE_COMPACT_LOG_MAX_BYTES) {
      fs.writeFileSync(logFile, '', 'utf8'); // start fresh — dumb cap, no rotation
    }
    fs.appendFileSync(logFile, `[hippo] ${new Date().toISOString()} ${sanitizeLogMessage(message)}\n`, 'utf8');
  } catch {
    // Diagnostic-only; a log write failure must never affect the exit-0 contract.
  }
}

/** True iff `filePath` exists and is readable — checks both in one call. */
function isReadableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false; // missing and unreadable both mean "no file" to the caller
  }
}

/** PreCompact stdout is the summariser's instructions; sent before the snapshot work because a locked store can run the hook past its 30 s limit, and via writeSync because process.exit drops buffered pipe output. */
function printPreCompactInstruction(logFile: string): void {
  try {
    fs.writeSync(1, `${PRE_COMPACT_INSTRUCTION}\n`);
  } catch (err) {
    appendPreCompactLog(logFile, `instruction not printed: ${errorMessage(err)}`);
  }
}

/** A session's task, summary and next step from its transcript tail, secrets scrubbed and capped, '' where none; null with a logged reason when nothing is derivable. */
export function transcriptWorkingState(transcriptPath: string, log: (message: string) => void): Pick<TaskSnapshot, 'task' | 'summary' | 'next_step'> | null {
  let tail = '';
  let rawTask = '';
  let rawNextStep = '';
  try {
    // Compaction fires when a big tool_result lands (CX7), so the last human and assistant turns can sit
    // megabytes back: grow the window a bounded number of times until both turns are in it.
    const size = fs.statSync(transcriptPath).size;
    for (const cap of [PRE_COMPACT_TAIL_BYTES, PRE_COMPACT_TAIL_BYTES * 4, PRE_COMPACT_TAIL_BYTES * 16]) {
      if (cap > PRE_COMPACT_TAIL_BYTES) log(`tail window grown to ${cap} bytes (last ${rawTask ? 'assistant' : 'user'} turn is further back)`);
      tail = readTranscriptTail(transcriptPath, cap);
      rawTask = lastPlainUserMessage(tail);
      rawNextStep = lastAssistantTextBlock(tail);
      if ((rawTask && rawNextStep) || size <= cap) break;
    }
  } catch (err) {
    log(`skip: could not read transcript tail: ${errorMessage(err)}`);
    return null;
  }

  const rawSummary = summariseTranscript(tail);
  if (!rawTask.trim() && !rawSummary.trim() && !rawNextStep.trim()) {
    log('skip: empty summary');
    return null;
  }

  // X9: these fields skip the capture content gate and reach a prompt, so the strict scrub runs. The caps protect the
  // re-injection token budget and never split a surrogate pair (X2); `hippo snapshot save` stays uncapped.
  const task = maskEmails(redactSecretsStrict(rawTask));
  const summary = maskEmails(redactSecretsStrict(rawSummary));
  const nextStep = maskEmails(redactSecretsStrict(rawNextStep));
  return {
    task: task.trim() ? truncateCodePointSafe(task, PRE_COMPACT_TASK_CAP) : '',
    summary: summary.trim() ? truncateKeepNewest(summary, PRE_COMPACT_SUMMARY_CAP) : '',
    next_step: nextStep.trim() ? truncateCodePointSafe(nextStep, PRE_COMPACT_NEXT_STEP_CAP) : '',
  };
}

/** Runs the PreCompact producer: records the compaction, asks the summariser for memories, saves a working-state snapshot. Never extracts memories itself; SessionEnd capture owns that. */
function runPreCompact(hippoRoot: string, stdinText: string | undefined, stdinTimedOut: boolean, logFile: string): void {
  // X3: the PreCompact hook fires in every Claude Code project, including
  // ones that never ran `hippo init`, so gate before any store-opening call
  // (saveActiveTaskSnapshot etc. call initStore, which would create one).
  if (!isInitialized(hippoRoot)) {
    appendPreCompactLog(logFile, 'skip: store not initialized');
    return;
  }

  const receipt = readClaudeCodePreCompact(stdinText, stdinTimedOut);
  if (receipt.status !== 'received') {
    appendPreCompactLog(logFile, `skip: ${receipt.reason}`);
    return;
  }
  const { sessionId, transcriptPath: payloadTranscriptPath, cwd: payloadCwd, trigger: payloadTrigger } = receipt.input;

  // The record is the "something saved before every compaction", so it lands even when no snapshot is derivable below.
  let recordId: string | null = null;
  if (sessionId !== null && sessionId !== '') {
    recordId = recordCompactionStart(
      hippoRoot,
      { sessionId, trigger: payloadTrigger, cwd: payloadCwd, transcriptPath: payloadTranscriptPath },
      (message) => appendPreCompactLog(logFile, message),
    );
    printPreCompactInstruction(logFile);
  }

  const transcriptPath = resolvePreCompactTranscript(payloadTranscriptPath, stdinText, logFile);
  if (!transcriptPath) return;

  // Nothing derivable skips the write, so a user-authored active snapshot is never clobbered with junk.
  const derived = transcriptWorkingState(transcriptPath, (message) => appendPreCompactLog(logFile, message));
  if (!derived) return;

  saveDerivedSnapshot(hippoRoot, logFile, sessionId, recordId, derived);
}

/** The transcript to snapshot, or null after logging why there is none. */
function resolvePreCompactTranscript(payloadTranscriptPath: string | null, stdinText: string | undefined, logFile: string): string | null {
  // A payload transcript_path is EXCLUSIVE: never fall back to
  // newest-transcript auto-discovery when it's missing/unreadable. That
  // fallback would snapshot a DIFFERENT session's transcript under THIS
  // payload's session_id — cross-session contamination with wrong linkage
  // (verify-stage E2E finding, 2026-08-03). Auto-discovery only applies
  // on a true manual invocation (no payload at all).
  let transcriptPath: string | null;
  if (payloadTranscriptPath !== null) {
    if (isReadableFile(payloadTranscriptPath)) {
      transcriptPath = payloadTranscriptPath;
    } else {
      appendPreCompactLog(logFile, `skip: payload transcript_path unreadable: ${payloadTranscriptPath}`);
      return null;
    }
  } else {
    transcriptPath = resolveLastSessionTranscript(undefined, stdinText, { mayScan: true });
  }

  if (!transcriptPath) {
    appendPreCompactLog(logFile, 'skip: no transcript resolved');
    return null;
  }
  return transcriptPath;
}

function saveDerivedSnapshot(
  hippoRoot: string,
  logFile: string,
  sessionId: string | null,
  recordId: string | null,
  derived: Pick<TaskSnapshot, 'task' | 'summary' | 'next_step'>,
): void {
  const tenantId = resolveTenantId({});

  // Per-field merge (X1): a tool-heavy tail whose only user turns are
  // tool_result arrays derives an empty task even though the summary is
  // non-empty. Loading the existing snapshot first lets each field fall
  // back independently instead of the whole write clobbering a
  // user-authored field with blank text.
  let existing: TaskSnapshot | null = null;
  try {
    existing = loadActiveTaskSnapshot(hippoRoot, tenantId);
  } catch {
    // No existing snapshot to merge against — proceed with derived-only.
  }

  // CX6 (codex round 2): field fallback must never move content across
  // sessions — session A's task carried into a snapshot saved under session
  // B's id would pass compact-resume's session gate wearing the wrong
  // badge. Fall back only when the existing snapshot has no session, this
  // payload has none, or they match.
  const fallback =
    existing !== null &&
    (existing.session_id === null || sessionId === null || existing.session_id === sessionId)
      ? existing
      : null;

  // Carried-over fields are not re-capped, as `hippo snapshot save` stays uncapped; saveActiveTaskSnapshot scrubs every field.
  const task = derived.task || (fallback?.task ?? '');
  const summary = derived.summary || (fallback?.summary ?? '');
  const nextStep = derived.next_step || (fallback?.next_step ?? '');

  // All-empty fields (cross-session tail with nothing derivable) skip the
  // write so a foreign session's junk never displaces the owning snapshot.
  if (!task && !summary && !nextStep) {
    appendPreCompactLog(logFile, 'skip: no snapshot content for this session (nothing derivable; fallback blocked or empty)');
  } else {
    try {
      saveActiveTaskSnapshot(hippoRoot, tenantId, {
        task,
        summary,
        next_step: nextStep,
        source: 'pre-compact',
        session_id: sessionId,
      });
      appendPreCompactLog(logFile, 'snapshot saved');
      if (recordId !== null) recordSnapshotSaved(hippoRoot, recordId, (message) => appendPreCompactLog(logFile, message));
    } catch (err) {
      appendPreCompactLog(logFile, `snapshot save failed: ${errorMessage(err)}`);
    }
  }
}

export interface PreCompactOptions {
  stdinText?: string;
  stdinTimedOut?: boolean;
  logFile?: string;
}

/**
 * PreCompact hook entry point. Exit code 2 on PreCompact BLOCKS compaction,
 * so this verb must exit 0 on every path — malformed stdin, missing
 * transcript, and store errors all degrade to a logged no-op rather than a
 * thrown error. Callers (src/cli.ts) must not wrap this in anything that
 * could turn a caught-and-logged failure back into a non-zero exit.
 */
export async function cmdPreCompact(hippoRoot: string, options: PreCompactOptions): Promise<void> {
  const logFile = options.logFile ?? defaultPreCompactLogPath();
  try {
    runPreCompact(hippoRoot, options.stdinText, options.stdinTimedOut ?? false, logFile);
  } catch (err) {
    appendPreCompactLog(logFile, `pre-compact failed: ${errorMessage(err)}`);
  }

  process.exit(0);
}

export interface PostCompactOptions {
  stdinText?: string;
  logFile?: string;
  afterSave?: (transcriptPath: string, cwd: string | null, log: (message: string) => void) => void;
}

/** A PostCompact hook has 10 s in all; replay stops starting new records after this. */
const POST_COMPACT_REPLAY_BUDGET_MS = 6000;

/** PostCompact entry point: saves the summary and its items, replays earlier leftovers, returns the one line to show. Never throws, so the hook exits 0. */
export function cmdPostCompact(hippoRoot: string, options: PostCompactOptions): string | null {
  const logFile = options.logFile ?? defaultPreCompactLogPath();
  const log = (message: string): void => appendPreCompactLog(logFile, `post-compact: ${message}`);
  const deadline = Date.now() + POST_COMPACT_REPLAY_BUDGET_MS;
  try {
    if (!isInitialized(hippoRoot)) {
      log('skip: no hippo store');
      return null;
    }
    const payload = parsePostCompactPayload(options.stdinText);
    let line: string | null = null;
    let storeBusy = false;
    if (payload === null) {
      log('skip: no PostCompact payload naming a session');
    } else {
      const saved = saveCompaction(hippoRoot, payload, log);
      line = postCompactLine(saved);
      storeBusy = saved.deferred;
      if (!storeBusy && payload.transcriptPath !== null && options.afterSave) {
        try {
          options.afterSave(payload.transcriptPath, payload.cwd, log);
        } catch (err) {
          log(`agent memory import failed: ${errorMessage(err)}`);
        }
      }
    }
    if (!storeBusy) replayCompactionsAt(hippoRoot, log, { busyWaitMs: COMPACTION_DB_WAIT_MS, deadline });
    return line;
  } catch (err) {
    log(`failed: ${errorMessage(err)}`);
    return null;
  }
}
