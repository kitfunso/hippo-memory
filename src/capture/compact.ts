import * as fs from 'fs';
import * as path from 'path';
import { type TaskSnapshot } from '../store/rows.js';
import { isInitialized } from '../store/open.js';
import { saveActiveTaskSnapshot, loadActiveTaskSnapshot } from '../store/sessions.js';
import {
  PRE_COMPACT_INSTRUCTION,
  postCompactLine,
  recordCompactionStart,
  recordSnapshotSaved,
  saveCompaction,
  replayCompactionsAt,
  COMPACTION_DB_WAIT_MS,
} from './compaction-record.js';
import { resolveTenantId } from '../store/tenant.js';
import { defaultPreCompactLogPath, vscodeUserHooksFile } from '../hooks/shared.js';
import { readClaudeCodePostCompact, readClaudeCodePreCompact, type CaptureInput, type HookRuntime } from '../core/capture-contract.js';
import { errorMessage, log as logger } from '../util/log.js';
import { resolveLastSessionTranscript } from './transcript.js';
import { isVscodeTranscript } from './copilot-transcript.js';
import { mergeWorkingState, transcriptWorkingState, type WorkingState } from './working-state.js';

// ---------------------------------------------------------------------------
// `hippo pre-compact` — PreCompact hook producer
// ---------------------------------------------------------------------------

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
    // One handle, so the cap acts on the file it measured; two hooks writing in the same instant can overwrite one diagnostic line, which this log accepts.
    const fd = fs.openSync(logFile, fs.constants.O_RDWR | fs.constants.O_CREAT);
    try {
      const size = fs.fstatSync(fd).size;
      const startFresh = size > PRE_COMPACT_LOG_MAX_BYTES; // a dumb cap, no rotation
      if (startFresh) fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, `[hippo] ${new Date().toISOString()} ${sanitizeLogMessage(message)}\n`, startFresh ? 0 : size, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // Diagnostic-only; a log write failure must never affect the exit-0 contract.
    logger.debug(`pre-compact log not written: ${errorMessage(err)}`);
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
function printPreCompactInstruction(logFile: string): string | null {
  const text = `${PRE_COMPACT_INSTRUCTION}\n`;
  try {
    fs.writeSync(1, text);
    return text;
  } catch (err) {
    appendPreCompactLog(logFile, `instruction not printed: ${errorMessage(err)}`);
    return null;
  }
}

/** The Copilot CLI accepts both preCompact and PreCompact, so hippo.json's pair can run twice for one compaction. */
const TWIN_FIRE_MS = 10_000;

function snapshotJustSaved(hippoRoot: string, sessionId: string | null): boolean {
  if (sessionId === null || sessionId === '') return false;
  const active = loadActiveTaskSnapshot(hippoRoot, resolveTenantId({}));
  return active?.session_id === sessionId && active.source === 'pre-compact' && Date.now() - Date.parse(active.updated_at) < TWIN_FIRE_MS;
}

/** Runs the PreCompact producer: records the compaction, asks the summariser for memories, saves a working-state snapshot. Never extracts memories itself; SessionEnd capture owns that. */
function runPreCompact(hippoRoot: string, options: PreCompactOptions, logFile: string): void {
  const { stdinText, stdinTimedOut = false, runtime = 'claude-code' } = options;
  // The PreCompact hook fires in every Claude Code project, including
  // ones that never ran `hippo init`, so gate before any store-opening call
  // (saveActiveTaskSnapshot etc. call initStore, which would create one).
  if (!isInitialized(hippoRoot)) {
    appendPreCompactLog(logFile, 'skip: store not initialized');
    return;
  }

  const receipt = readClaudeCodePreCompact(stdinText, stdinTimedOut, runtime);
  if (receipt.status !== 'received') {
    appendPreCompactLog(logFile, `skip: ${receipt.reason}`);
    return;
  }
  const { sessionId, transcriptPath: payloadTranscriptPath } = receipt.input;
  // With chat.useClaudeHooks on, VS Code runs Claude Code's hooks too; it never sends PostCompact to close a record, nor reads the summariser text.
  const vscode = runtime === 'claude-code' && isVscodeTranscript(payloadTranscriptPath);
  if (vscode && fs.existsSync(vscodeUserHooksFile())) {
    appendPreCompactLog(logFile, 'skip: VS Code payload, hippo.json runs pre-compact for this chat');
    return;
  }
  if (runtime === 'copilot' && snapshotJustSaved(hippoRoot, sessionId)) {
    appendPreCompactLog(logFile, `skip: snapshot for session ${sessionId} saved under ${TWIN_FIRE_MS / 1000} s ago, by the other preCompact entry`);
    return;
  }

  const recordId = markCompactionBoundary(hippoRoot, options, logFile, receipt.input, runtime === 'claude-code' && !vscode);

  const transcriptPath = resolvePreCompactTranscript(payloadTranscriptPath, stdinText, logFile, runtime);
  if (!transcriptPath) return;

  // Nothing derivable skips the write, so a user-authored active snapshot is never clobbered with junk.
  const derived = transcriptWorkingState(transcriptPath, (message) => appendPreCompactLog(logFile, message));
  if (!derived) return;

  saveDerivedSnapshot(hippoRoot, logFile, sessionId, recordId, derived);
}

/** Starts the compaction record when the host will close one (`closable`), then tells `onBoundary` what was printed; the record id, or null without a record. */
function markCompactionBoundary(hippoRoot: string, options: PreCompactOptions, logFile: string, input: CaptureInput, closable: boolean): string | null {
  const { sessionId } = input;
  // The record is the "something saved before every compaction", so it lands even when no snapshot is derivable later.
  // Copilot has no PostCompact hook to close a record, so its compactions get the snapshot alone.
  let recordId: string | null = null;
  let printed: string | null = null;
  if (closable && sessionId !== null && sessionId !== '') {
    recordId = recordCompactionStart(
      hippoRoot,
      { sessionId, trigger: input.trigger, cwd: input.cwd, transcriptPath: input.transcriptPath },
      (message) => appendPreCompactLog(logFile, message),
    );
    printed = printPreCompactInstruction(logFile);
  }
  // Its own guard, so a throwing callback can never skip the snapshot work that follows.
  try {
    options.onBoundary?.(printed);
  } catch (err) {
    appendPreCompactLog(logFile, `boundary callback failed: ${errorMessage(err)}`);
  }
  return recordId;
}

/** The transcript to snapshot, or null after logging why there is none. */
function resolvePreCompactTranscript(
  payloadTranscriptPath: string | null,
  stdinText: string | undefined,
  logFile: string,
  runtime: HookRuntime,
): string | null {
  // A payload transcript_path is EXCLUSIVE: auto-discovery would snapshot a DIFFERENT session's
  // transcript under THIS payload's session_id, so it runs only on a manual invocation (no payload).
  let transcriptPath: string | null;
  if (payloadTranscriptPath !== null) {
    if (isReadableFile(payloadTranscriptPath)) {
      transcriptPath = payloadTranscriptPath;
    } else {
      appendPreCompactLog(logFile, `skip: payload transcript_path unreadable: ${payloadTranscriptPath}`);
      return null;
    }
  } else if (runtime === 'copilot') {
    // The scan only knows Claude Code's folders, so a manual Copilot run would snapshot a Claude session.
    transcriptPath = null;
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
  derived: WorkingState,
): void {
  const tenantId = resolveTenantId({});

  let existing: TaskSnapshot | null = null;
  try {
    existing = loadActiveTaskSnapshot(hippoRoot, tenantId);
  } catch (err) {
    logger.debug(`pre-compact: stored snapshot unreadable, saving the derived one alone: ${errorMessage(err)}`);
  }

  // Carried-over fields are not re-capped, as `hippo snapshot save` stays uncapped; saveActiveTaskSnapshot scrubs every field.
  const merged = mergeWorkingState(derived, existing, sessionId);
  if (merged === null) {
    appendPreCompactLog(logFile, 'skip: no snapshot content for this session (nothing derivable; fallback blocked or empty)');
  } else {
    try {
      saveActiveTaskSnapshot(hippoRoot, tenantId, { ...merged, source: 'pre-compact', session_id: sessionId });
      appendPreCompactLog(logFile, 'snapshot saved');
      if (recordId !== null) recordSnapshotSaved(hippoRoot, tenantId, recordId, (message) => appendPreCompactLog(logFile, message));
    } catch (err) {
      appendPreCompactLog(logFile, `snapshot save failed: ${errorMessage(err)}`);
    }
  }
}

export interface PreCompactOptions {
  stdinText?: string;
  stdinTimedOut?: boolean;
  logFile?: string;
  runtime?: HookRuntime;
  /** Called once when the hook accepts a compaction, with the text it printed or null when it printed none. */
  onBoundary?: (printed: string | null) => void;
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
    runPreCompact(hippoRoot, options, logFile);
  } catch (err) {
    appendPreCompactLog(logFile, `pre-compact failed: ${errorMessage(err)}`);
  }

  process.exit(0);
}

export interface PostCompactOptions {
  stdinText?: string;
  stdinTimedOut?: boolean;
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
    const receipt = readClaudeCodePostCompact(options.stdinText, options.stdinTimedOut ?? false);
    let line: string | null = null;
    let storeBusy = false;
    if (receipt.status !== 'received') {
      log(`skip: ${receipt.reason}`);
    } else {
      const saved = saveCompaction(hippoRoot, receipt.input, log);
      line = postCompactLine(saved);
      storeBusy = saved.deferred;
      if (!storeBusy && receipt.input.transcriptPath !== null && options.afterSave) {
        try {
          options.afterSave(receipt.input.transcriptPath, receipt.input.cwd, log);
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
