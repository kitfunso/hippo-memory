import * as fs from 'node:fs';
import * as path from 'node:path';
import { isInitialized } from '../../host/project-identity.js';
import {
  PRE_COMPACT_INSTRUCTION,
  postCompactLine,
  saveCompaction,
  replayCompactions,
} from './compaction-record.js';
import { COMPACTION_DB_WAIT_MS } from '../../base/session/compaction-timing.js';
import { defaultPreCompactLogPath, vscodeUserHooksFile } from '../hooks-install/rules/shared.js';
import { processHomes } from '../../host/agent-homes.js';
import {
  readClaudeCodePostCompact,
  readClaudeCodePreCompact,
  type CaptureInput,
  type HookRuntime,
} from '../../base/session/capture-contract.js';
import {
  errorCode,
  errorMessage,
  log as logger,
  errorFields,
  formatFields,
  type LineLog,
  type LogFields,
} from '../../base/util/log.js';
import type { Log } from '../../infra/spool-files.js';
import { exitAfterFlush } from '../../base/util/crash-handlers.js';
import { resolveLastSessionTranscript } from './transcript.js';
import { isVscodeTranscript } from './copilot-transcript.js';
import { transcriptWorkingState } from './working-state.js';
import type { StoreGroups } from '../../base/ports/store.js';
import { PRIVATE_DIR } from '../../host/private-dir.js';
import { preCompact, type PreCompactContext } from '../../api/pre-compact.js';

// Diagnostic-only log; a long-lived install must not grow it unbounded.
const PRE_COMPACT_LOG_MAX_BYTES = 256 * 1024;

/** Log-forgery guard: strip C0 control chars (newlines above all) from payload-controlled values
 * so a crafted value cannot inject fake `[hippo]` log lines. Exported as the one shared guard
 * for every `[hippo]`-prefixed log writer that interpolates payload values. */
export function sanitizeLogMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\x00-\x1f]/g, '');
}

function appendPreCompactLog(logFile: string, message: string, fields?: LogFields): void {
  try {
    fs.mkdirSync(path.dirname(logFile), PRIVATE_DIR);
    // One handle, so the cap acts on the file it measured; two hooks writing in the same instant
    // can overwrite one diagnostic line, which this log accepts.
    const fd = fs.openSync(logFile, fs.constants.O_RDWR | fs.constants.O_CREAT);
    try {
      const size = fs.fstatSync(fd).size;
      const startFresh = size > PRE_COMPACT_LOG_MAX_BYTES; // a dumb cap, no rotation
      if (startFresh) fs.ftruncateSync(fd, 0);
      const line = `[hippo] ${new Date().toISOString()} ${sanitizeLogMessage(`${message}${formatFields(fields)}`)}\n`;
      fs.writeSync(fd, line, startFresh ? 0 : size, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // A log write failure must never affect the exit-0 contract, but a log that never fills is
    // told.
    logger.warn(`pre-compact log not written: ${errorMessage(err)}`, errorFields(err));
  }
}

/** True iff `filePath` exists and is readable — checks both in one call. */
function isReadableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch (err) {
    // A missing file is the expected miss; a permission or I/O fault is told, then the caller still
    // skips the file.
    if (errorCode(err) !== 'ENOENT') {
      logger.warn(`cannot read ${filePath}: ${errorMessage(err)}`, errorFields(err));
    }
    return false;
  }
}

/** PreCompact stdout is the summarizer's instructions; sent before the snapshot work because a
 * locked store can run the hook past its HOOK_LONG_TIMEOUT_SECONDS limit, and via writeSync
 * because process.exit drops buffered pipe output. */
function printPreCompactInstruction(logFile: string): string | null {
  const text = `${PRE_COMPACT_INSTRUCTION}\n`;
  try {
    fs.writeSync(1, text);
    return text;
  } catch (err) {
    appendPreCompactLog(logFile, `instruction not printed: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
}

/** Hands the accepted payload to the api's PreCompact with the host steps: the instruction on
 * stdout, the transcript's working state and this hook's log file. */
async function runPreCompact(
  hippoRoot: string,
  ctx: PreCompactContext,
  options: PreCompactOptions,
  logFile: string,
): Promise<void> {
  const accepted = acceptPreCompact(hippoRoot, options, logFile);
  if (accepted === null) return;
  const { input, vscode } = accepted;
  const { stdinText, runtime = 'claude-code' } = options;
  const logLine: LineLog = (message, opts) => appendPreCompactLog(logFile, message, opts?.fields);
  await preCompact(ctx, {
    input,
    closable: runtime === 'claude-code' && !vscode,
    twinFires: runtime === 'copilot',
    printInstruction: () => printPreCompactInstruction(logFile),
    onBoundary: options.onBoundary,
    workingState: () => {
      const transcriptPath = resolvePreCompactTranscript(
        input.transcriptPath,
        stdinText,
        logFile,
        runtime,
      );
      return transcriptPath ? transcriptWorkingState(transcriptPath, logLine) : null;
    },
    log: logLine,
  });
}

/** The compaction payload this entry runs, or null after logging why it skips it. */
function acceptPreCompact(
  hippoRoot: string,
  options: PreCompactOptions,
  logFile: string,
): { input: CaptureInput; vscode: boolean } | null {
  const { stdinText, stdinTimedOut = false, runtime = 'claude-code' } = options;
  // PreCompact fires in every Claude Code project, including ones that never ran `hippo init`; gate
  // before any call that would create a store.
  if (!isInitialized(hippoRoot)) {
    appendPreCompactLog(logFile, 'skip: store not initialized');
    return null;
  }

  const receipt = readClaudeCodePreCompact(stdinText, stdinTimedOut, runtime);
  if (receipt.status !== 'received') {
    appendPreCompactLog(logFile, `skip: ${receipt.reason}`);
    return null;
  }
  // With chat.useClaudeHooks on, VS Code runs Claude Code's hooks too; it never sends PostCompact
  // to close a record, nor reads the summarizer text.
  const vscode = runtime === 'claude-code' && isVscodeTranscript(receipt.input.transcriptPath);
  if (vscode && fs.existsSync(vscodeUserHooksFile(processHomes()))) {
    appendPreCompactLog(
      logFile,
      'skip: VS Code payload, hippo.json runs pre-compact for this chat',
    );
    return null;
  }
  return { input: receipt.input, vscode };
}

/** The transcript to snapshot, or null after logging why there is none. */
function resolvePreCompactTranscript(
  payloadTranscriptPath: string | null,
  stdinText: string | undefined,
  logFile: string,
  runtime: HookRuntime,
): string | null {
  // A payload transcript_path is EXCLUSIVE: auto-discovery would snapshot a DIFFERENT session's
  // transcript under THIS payload's session_id, so it runs only on a manual invocation (no
  // payload).
  let transcriptPath: string | null;
  if (payloadTranscriptPath !== null) {
    if (isReadableFile(payloadTranscriptPath)) {
      transcriptPath = payloadTranscriptPath;
    } else {
      appendPreCompactLog(
        logFile,
        `skip: payload transcript_path unreadable: ${payloadTranscriptPath}`,
      );
      return null;
    }
  } else if (runtime === 'copilot') {
    // The scan only knows Claude Code's folders, so a manual Copilot run would snapshot a Claude
    // session.
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

export interface PreCompactOptions {
  stdinText?: string;
  stdinTimedOut?: boolean;
  logFile?: string;
  runtime?: HookRuntime;
  /** Called once when the hook accepts a compaction, with the text it printed or null when it
   * printed none. */
  onBoundary?: (printed: string | null) => void;
}

/** PreCompact hook entry point. Exit code 2 BLOCKS compaction, so every path (bad stdin, missing
 * transcript, store error) must exit 0 as a logged no-op. Callers must not wrap this in anything
 * that turns a caught-and-logged failure into a non-zero exit. */
export async function preCompactHook(
  hippoRoot: string,
  ctx: PreCompactContext,
  options: PreCompactOptions,
): Promise<void> {
  const logFile = options.logFile ?? defaultPreCompactLogPath(processHomes());
  try {
    await runPreCompact(hippoRoot, ctx, options, logFile);
  } catch (err) {
    appendPreCompactLog(logFile, `pre-compact failed: ${errorMessage(err)}`, errorFields(err));
    logger.error(`pre-compact failed: ${errorMessage(err)}`, errorFields(err));
  }

  exitAfterFlush(0);
}

/** The folder's store as a PostCompact hook reaches it, built by the CLI root. */
export type CompactionStore = Pick<StoreGroups, 'compactionHooks'>;

export interface PostCompactOptions {
  /** The tenant the CLI root resolved. */
  tenantId: string;
  stdinText?: string;
  stdinTimedOut?: boolean;
  logFile?: string;
  afterSave?: (
    transcriptPath: string,
    cwd: string | null,
    log: (message: string) => void,
  ) => Promise<void>;
}

/** A PostCompact hook has HOOK_MEDIUM_TIMEOUT_SECONDS in all; replay stops starting new records
 * after this. */
const POST_COMPACT_REPLAY_BUDGET_MS = 6000;

/** PostCompact entry point: saves the summary and its items, replays earlier leftovers, returns
 * the one line to show. Never throws, so the hook exits 0. */
export async function postCompactHook(
  hippoRoot: string,
  store: CompactionStore,
  options: PostCompactOptions,
): Promise<string | null> {
  const logFile = options.logFile ?? defaultPreCompactLogPath(processHomes());
  const log: Log = (message, fields) => {
    appendPreCompactLog(logFile, `post-compact: ${message}`, fields);
    if (fields !== undefined) logger.error(`post-compact: ${message}`, fields);
  };
  const deadline = Date.now() + POST_COMPACT_REPLAY_BUDGET_MS;
  try {
    if (!isInitialized(hippoRoot)) {
      log('skip: no hippo store');
      return null;
    }
    const receipt = readClaudeCodePostCompact(options.stdinText, options.stdinTimedOut ?? false);
    const folder = { root: hippoRoot, store, tenantId: options.tenantId };
    let line: string | null = null;
    let storeBusy = false;
    if (receipt.status !== 'received') {
      log(`skip: ${receipt.reason}`);
    } else {
      const saved = await saveCompaction(folder, receipt.input, log);
      line = postCompactLine(saved);
      storeBusy = saved.deferred;
      if (!storeBusy && receipt.input.transcriptPath !== null && options.afterSave) {
        try {
          await options.afterSave(receipt.input.transcriptPath, receipt.input.cwd, log);
        } catch (err) {
          log(`agent memory import failed: ${errorMessage(err)}`, errorFields(err));
        }
      }
    }
    if (!storeBusy) {
      await replayCompactions(folder, log, { busyWaitMs: COMPACTION_DB_WAIT_MS, deadline });
    }
    return line;
  } catch (err) {
    log(`failed: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
}
