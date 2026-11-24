import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskSnapshot, Sessions } from '../../base/ports/store/sessions.js';
import { isInitialized } from '../../host/project-identity.js';
import {
  PRE_COMPACT_INSTRUCTION,
  postCompactLine,
  saveCompaction,
  replayCompactions,
} from './compaction-record.js';
import type { CompactionHooks, CompactionStart } from '../../base/ports/store/capture.js';
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
  type LogFields,
} from '../../base/util/log.js';
import type { Log } from '../../infra/spool-files.js';
import { exitAfterFlush } from '../../base/util/crash-handlers.js';
import { resolveLastSessionTranscript } from './transcript.js';
import { isVscodeTranscript } from './copilot-transcript.js';
import { mergeWorkingState, type WorkingState } from '../../base/session/working-state.js';
import { transcriptWorkingState } from './working-state.js';
import type { StoreGroups } from '../../base/ports/store.js';
import { PRIVATE_DIR } from '../../host/private-dir.js';

const PRE_COMPACT_LOG_MAX_BYTES = 256 * 1024;

/** Log-forgery guard: strip control chars (U+0000-U+001F, DEL, U+0080-U+009F; newlines and NEL
 * above all) so a crafted value cannot inject fake `[hippo]` lines or terminal escapes. The one
 * shared guard for every log line and printed name that interpolates payload values. */
export function sanitizeLogMessage(message: string): string {
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

function appendPreCompactLog(logFile: string, message: string, fields?: LogFields): void {
  try {
    fs.mkdirSync(path.dirname(logFile), PRIVATE_DIR);
    const fd = fs.openSync(logFile, fs.constants.O_RDWR | fs.constants.O_CREAT);
    try {
      const size = fs.fstatSync(fd).size;
      const startFresh = size > PRE_COMPACT_LOG_MAX_BYTES;
      if (startFresh) fs.ftruncateSync(fd, 0);
      const line = `[hippo] ${new Date().toISOString()} ${sanitizeLogMessage(`${message}${formatFields(fields)}`)}\n`;
      fs.writeSync(fd, line, startFresh ? 0 : size, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    logger.warn(`pre-compact log not written: ${errorMessage(err)}`, errorFields(err));
  }
}

function isReadableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      logger.warn(`cannot read ${filePath}: ${errorMessage(err)}`, errorFields(err));
    }
    return false;
  }
}

/** PreCompact stdout is the summarizer's instructions; sent before the snapshot work because a
 * locked store can run the hook past its 30 s limit, and via writeSync because process.exit
 * drops buffered pipe output. */
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

/** The Copilot CLI accepts both preCompact and PreCompact, so hippo.json's pair can run twice
 * for one compaction. */
const TWIN_FIRE_MS = 10_000;

/** The folder's store as a compaction hook reaches it, built by the CLI root. */
export type CompactionStore = Pick<StoreGroups, 'compactionHooks' | 'sessions'>;

async function snapshotJustSaved(
  sessions: Sessions,
  tenantId: string,
  sessionId: string | null,
): Promise<boolean> {
  if (sessionId === null || sessionId === '') return false;
  const active = await sessions.loadSnapshot(tenantId, {}, null);
  return (
    active?.sessionId === sessionId &&
    active.source === 'pre-compact' &&
    Date.now() - Date.parse(active.updatedAt) < TWIN_FIRE_MS
  );
}

async function runPreCompact(
  hippoRoot: string,
  store: CompactionStore,
  options: PreCompactOptions,
  logFile: string,
): Promise<void> {
  const accepted = await acceptPreCompact(hippoRoot, store, options, logFile);
  if (accepted === null) return;
  const { input, vscode } = accepted;
  const { stdinText, runtime = 'claude-code' } = options;
  const closable = runtime === 'claude-code' && !vscode;
  const recordId = await markCompactionBoundary({
    hooks: store.compactionHooks,
    options,
    logFile,
    input,
    closable,
  });

  const transcriptPath = resolvePreCompactTranscript(
    input.transcriptPath,
    stdinText,
    logFile,
    runtime,
  );
  if (!transcriptPath) return;

  const derived = transcriptWorkingState(
    transcriptPath,
    (message, opts) => appendPreCompactLog(logFile, message, opts?.fields),
    { scriptedIsHuman: options.scriptedIsHuman },
  );
  if (!derived) return;

  const { sessionId } = input;
  await saveDerivedSnapshot(store, {
    tenantId: options.tenantId,
    logFile,
    sessionId,
    recordId,
    derived,
  });
}

async function acceptPreCompact(
  hippoRoot: string,
  store: CompactionStore,
  options: PreCompactOptions,
  logFile: string,
): Promise<{ input: CaptureInput; vscode: boolean } | null> {
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
  const skip = await otherEntrySkip(store, options, receipt.input.sessionId, vscode);
  if (skip !== null) {
    appendPreCompactLog(logFile, skip);
    return null;
  }
  return { input: receipt.input, vscode };
}

async function otherEntrySkip(
  store: CompactionStore,
  options: PreCompactOptions,
  sessionId: string | null,
  vscode: boolean,
): Promise<string | null> {
  if (vscode && fs.existsSync(vscodeUserHooksFile(processHomes()))) {
    return 'skip: VS Code payload, hippo.json runs pre-compact for this chat';
  }
  if (
    options.runtime === 'copilot' &&
    (await snapshotJustSaved(store.sessions, options.tenantId, sessionId))
  ) {
    const window = `${TWIN_FIRE_MS / 1000} s`;
    return `skip: snapshot for session ${sessionId} saved under ${window} ago, by the other preCompact entry`;
  }
  return null;
}

interface MarkCompactionBoundaryOptions {
  readonly hooks: CompactionHooks;
  readonly options: PreCompactOptions;
  readonly logFile: string;
  readonly input: CaptureInput;
  readonly closable: boolean;
}

async function markCompactionBoundary({
  hooks,
  options,
  logFile,
  input,
  closable,
}: MarkCompactionBoundaryOptions): Promise<string | null> {
  const { sessionId } = input;
  // The record is the "something saved before every compaction", so it lands even when no snapshot
  // is derivable later. Copilot has no PostCompact hook to close a record, so its compactions get
  // the snapshot alone.
  let recordId: string | null = null;
  let printed: string | null = null;
  if (closable && sessionId !== null && sessionId !== '') {
    recordId = await startRecord(
      hooks,
      options.tenantId,
      { sessionId, trigger: input.trigger, cwd: input.cwd, transcriptPath: input.transcriptPath },
      logFile,
    );
    printed = printPreCompactInstruction(logFile);
  }
  try {
    options.onBoundary?.(printed);
  } catch (err) {
    appendPreCompactLog(
      logFile,
      `boundary callback failed: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
  return recordId;
}

async function startRecord(
  hooks: CompactionHooks,
  tenantId: string,
  start: Omit<CompactionStart, 'originProject'>,
  logFile: string,
): Promise<string | null> {
  try {
    return await hooks.start(tenantId, start);
  } catch (err) {
    appendPreCompactLog(
      logFile,
      `compaction record not started: ${errorMessage(err)}`,
      errorFields(err),
    );
    return null;
  }
}

async function markSnapshotOnRecord(
  hooks: CompactionHooks,
  { tenantId, recordId, logFile }: { tenantId: string; recordId: string; logFile: string },
): Promise<void> {
  try {
    await hooks.markSnapshotSaved(tenantId, recordId);
  } catch (err) {
    appendPreCompactLog(
      logFile,
      `compaction record not marked with its snapshot: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

function resolvePreCompactTranscript(
  payloadTranscriptPath: string | null,
  stdinText: string | undefined,
  logFile: string,
  runtime: HookRuntime,
): string | null {
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

interface DerivedSnapshot {
  readonly tenantId: string;
  readonly logFile: string;
  readonly sessionId: string | null;
  readonly recordId: string | null;
  readonly derived: WorkingState;
}

async function saveDerivedSnapshot(
  { compactionHooks: hooks, sessions }: CompactionStore,
  { tenantId, logFile, sessionId, recordId, derived }: DerivedSnapshot,
): Promise<void> {
  let existing: TaskSnapshot | null = null;
  try {
    existing = await sessions.loadSnapshot(tenantId, {}, null);
  } catch (err) {
    logger.warn(
      `pre-compact: stored snapshot unreadable, saving the derived one alone: ${errorMessage(err)}`,
      errorFields(err),
    );
  }

  const merged = mergeWorkingState(derived, existing, sessionId);
  if (merged === null) {
    appendPreCompactLog(
      logFile,
      'skip: no snapshot content for this session (nothing derivable; fallback blocked or empty)',
    );
  } else {
    try {
      await sessions.save(
        tenantId,
        'snapshot',
        { ...merged, source: 'pre-compact', sessionId },
        null,
      );
      appendPreCompactLog(logFile, 'snapshot saved');
      if (recordId !== null) await markSnapshotOnRecord(hooks, { tenantId, recordId, logFile });
    } catch (err) {
      appendPreCompactLog(logFile, `snapshot save failed: ${errorMessage(err)}`, errorFields(err));
    }
  }
}

export interface PreCompactOptions {
  tenantId: string;
  stdinText?: string;
  stdinTimedOut?: boolean;
  logFile?: string;
  runtime?: HookRuntime;
  scriptedIsHuman?: boolean;
  onBoundary?: (printed: string | null) => void;
}

/** PreCompact hook entry point. Exit code 2 BLOCKS compaction, so every path (bad stdin, missing
 * transcript, store error) must exit 0 as a logged no-op. Callers must not wrap this in anything
 * that turns a caught-and-logged failure into a non-zero exit. */
export async function preCompactHook(
  hippoRoot: string,
  store: CompactionStore,
  options: PreCompactOptions,
): Promise<void> {
  const logFile = options.logFile ?? defaultPreCompactLogPath(processHomes());
  try {
    await runPreCompact(hippoRoot, store, options, logFile);
  } catch (err) {
    appendPreCompactLog(logFile, `pre-compact failed: ${errorMessage(err)}`, errorFields(err));
    logger.error(`pre-compact failed: ${errorMessage(err)}`, errorFields(err));
  }

  exitAfterFlush(0);
}

export interface PostCompactOptions {
  tenantId: string;
  stdinText?: string;
  stdinTimedOut?: boolean;
  logFile?: string;
  afterSave?: (transcriptPath: string, cwd: string | null) => void | Promise<void>;
}

/** A PostCompact hook has 10 s in all; replay stops starting new records after this. */
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
          await options.afterSave(receipt.input.transcriptPath, receipt.input.cwd);
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
