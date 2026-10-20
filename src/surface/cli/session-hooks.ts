// Agent lifecycle hook verbs: session end, compaction, tool-failure capture and the Codex wrapper.

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { resolveCodexSessionTranscript } from '../../domain/hooks/codex-session.js';
import { installedRealCodexPath, resolveCodexWrapperPaths } from '../../domain/hooks/codex-wrapper.js';
import { resolveJsonHookPaths } from '../../domain/hooks/json-hooks.js';
import { readSessionScan, recordSessionDigest, type SessionScan } from '../capture/session-digest.js';
import { captureToolFailure } from '../capture/capture-error.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { importSessionFolder } from '../../domain/agent-memories/sync.js';
import { currentMachine } from '../../base/util/agent-homes.js';
import { summaryLine } from '../../domain/agent-memories/report.js';
import { resolveProjectIdentity, isInitialized, type ProjectRef } from '../../base/scope/project-identity.js';
import { cmdCapture, type CaptureOptions, type CaptureTarget } from '../capture/command.js';
import { getGlobalRoot } from '../../domain/sharing/global-store.js';
import { cmdPreCompact, cmdPostCompact } from '../capture/compact.js';
import { transcriptWorkingState } from '../capture/working-state.js';
import { collectHandoffEvidence } from '../capture/handoff-evidence.js';
import { type SessionTurn } from '../capture/transcript.js';
import { copilotTranscriptFor, SESSION_ID_RE } from '../capture/copilot-transcript.js';
import {
  loadTurnPosition,
  runSessionWorker,
  saveTurnPosition,
  turnsAfter,
  type WorkerMode,
} from '../capture/session-worker.js';
import {
  isStringValue,
  readSessionEnd,
  readVscodeStop,
  type CaptureInput,
  type HookRuntime,
} from '../../base/session/capture-contract.js';
import { COMPACTION_DB_WAIT_MS } from '../../base/session/compaction-timing.js';
import { compactResumeBlock, sessionEndWork as runSessionEnd } from '../../api/session-end.js';
import { normalizeHookPayload, readHookStdin, readStdinBounded, type BoundedStdin } from './stdin.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import { cmdShimArgs } from '../../base/util/spawn-argv.js';
import { bookLedgerTurn } from '../../api/ledger-db.js';
import { flushDeliveryRecorder, startDeliveryRecorder, startToolFailureRecorder } from '../../api/prompt-hook.js';
import type { DeliveryRecorder } from '../../api/delivery-recorder.js';
import { printError } from './output.js';
import { cmdLastSleep } from './last-sleep.js';
import { readCompactResumePayload } from './compact-resume-payload.js';
import {
  cliApiContext,
  cliHookRequest,
  cliLedgerReach,
  cliLocalFiles,
  cliStore,
  cliSyncOptions,
  cliConfig,
} from './api-context.js';
import {
  type CliFlags,
  type CommandContext,
  boolFlag,
  flagIsTrue,
  stringFlag,
  stringFlagOrExit,
} from './flag-values.js';
import {
  logSessionEndImport,
  appendSessionEndCloseLog,
  reportSessionEndFailure,
  resetHookInjection,
  hookStoreRoot,
  hookRuntime,
  payloadCwdRoot,
  inPilotHoldout,
  hostSessionId,
} from './hook-runtime.js';
import { parseJson } from '../../base/util/json.js';
import { ignoringCodes } from '../../base/util/expected-errors.js';
import { CliExit, fail } from './exit.js';

const captureTarget = (root: string): CaptureTarget => ({ root, files: cliLocalFiles(root), config: cliConfig(root) });

/** SessionStart(compact) injector: prints the task snapshot and session trail lost to compaction; no pinned memories
 * (UserPromptSubmit re-injects them). Every path exits 0: a malformed payload or store read failure degrades to empty
 * stdout, never a throw. */
async function cmdCompactResume(
  hippoRoot: string,
  tenantId: string,
  stdinText: string | undefined,
  stdinTimedOut: boolean,
): Promise<void> {
  let rec: DeliveryRecorder | null = null;
  try {
    // Gate on the non-exiting isInitialized check first: the store reads below call initStore, which would silently
    // create a store in a project that never ran `hippo init`, and this hook fires globally.
    if (!isInitialized(hippoRoot)) {
      throw new CliExit(0);
    }

    const payloadState = readCompactResumePayload(stdinText, stdinTimedOut);
    let suppressOutput = payloadState.suppressOutput;
    const payloadSessionId = payloadState.payloadSessionId;

    if (payloadState.boundary) {
      rec = startDeliveryRecorder(cliApiContext(hippoRoot, tenantId), {
        stdinText,
        runtime: 'claude-code',
        eventType: 'compact-resume',
        envSessionId: hostSessionId(),
      });
    }

    // A compaction follows a prompt or SessionStart that booked the arm, so this only reads it.
    if (
      !suppressOutput &&
      payloadSessionId !== null &&
      inPilotHoldout(hippoRoot, tenantId, payloadSessionId, { write: false })
    ) {
      suppressOutput = true;
      rec?.disabled();
    }

    if (!suppressOutput) await restoreCompactSnapshot(hippoRoot, tenantId, payloadSessionId, rec);
  } catch (err) {
    if (err instanceof CliExit) throw err;
    // Empty stdout on any store error, never a crashed SessionStart; the reason goes to stderr, which the model never
    // sees.
    log.warn(`hippo compact-resume: skipped: ${errorMessage(err)}`, errorFields(err));
  }
  // A no-op when the token ledger's handle already wrote the row; exit would drop it otherwise.
  flushDeliveryRecorder(rec);
  throw new CliExit(0);
}

async function restoreCompactSnapshot(
  hippoRoot: string,
  tenantId: string,
  payloadSessionId: string | null,
  rec: DeliveryRecorder | null,
): Promise<void> {
  const text = await compactResumeBlock(cliApiContext(hippoRoot, tenantId), payloadSessionId);
  if (text === null) return;
  // Printed in one write so the ledger books exactly the text the model is handed.
  console.log(text);
  rec?.delivered({ state: 'sent', emittedText: `${text}\n` });
  bookLedgerTurn(
    {
      uses: [
        {
          tenantId,
          sessionId: payloadSessionId,
          surface: 'compact_resume',
          event: 'inject',
          items: 1,
          tokens: estimateTokens(text),
        },
      ],
      delivery: (write) => flushDeliveryRecorder(rec, write),
    },
    cliLedgerReach(hippoRoot),
  );
}

/** SessionEnd entry: TUI teardown kills children still running, so read stdin inline, spawn a detached child that runs
 * sleep then capture, and exit. The child logs to a file that the next SessionStart reads via `hippo last-sleep`. */
export async function handleSessionEnd({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const runtime = hookRuntime(flags);
  const turn = flagIsTrue(flags, 'turn');
  // Copilot's hook command carries no path, since one quoted into it would need escaping for each shell; the log goes
  // where the hook table used to point.
  const logFile =
    stringFlag(flags, 'log-file') ?? (runtime === 'copilot' ? resolveJsonHookPaths('copilot').logFile : null);

  // Bounded read: extracts transcript_path + session_id for the detached worker's argv.
  const raw = await readStdinBounded();
  // Read before normalizing: the Copilot CLI's agentStop shares this hook line, and camelCase keys would pass as VS
  // Code's.
  const stop = turn ? vscodeStopInput(raw) : null;
  if (turn && !stop) return;
  const stdinText = normalizeHookPayload(raw.text);
  // Before the spawn, since the worker finds its store from the folder it inherits.
  const root = payloadCwdRoot(hippoRoot, stdinText, runtime);
  const input = stop ?? sessionEndInput(stdinText, raw.timedOut, runtime);
  // Only a host payload ends a session: a manual run and a reply's end (turn mode) are not boundaries.
  const rec =
    !turn && input !== null && !input.manual ? startSessionEndRecorder(root, tenantId, stdinText, runtime) : null;
  const sessionId = input?.sessionId ?? null;
  // Resolved here because only this process saw the payload; the worker captures just the path it is handed. Always a
  // hook, so never scan: an empty stdin here is not a manual run. The Copilot CLI's sessionEnd names no transcript, so
  // its log is found by id.
  const named = input?.transcriptPath ?? null;
  const transcriptPath =
    (named !== null && fs.existsSync(named) ? named : null) ??
    (runtime === 'copilot' && sessionId ? copilotTranscriptFor(sessionId) : null);

  const worker: SessionEndWorkerInput = { logFile, transcriptPath, sessionId, turn };
  try {
    spawnSessionEndWorker(sessionEndWorkerArgs(worker));
  } catch (err) {
    log.debug(`session-end: the worker did not spawn, running inline: ${errorMessage(err)}`, errorFields(err));
    // Inline is the last resort, handed what the child's argv would have carried.
    try {
      await cmdSessionEndWorker(root, tenantId, inlineWorkerFlags(flags, worker));
    } finally {
      await cliHookRequest(() => flushDeliveryRecorder(rec));
    }
    return;
  }
  // After the spawn, so a locked store delays only the row; the hook's short lock wait bounds it.
  await cliHookRequest(() => flushDeliveryRecorder(rec));
}

function startSessionEndRecorder(
  root: string,
  tenantId: string,
  stdinText: string | undefined,
  runtime: HookRuntime,
): DeliveryRecorder | null {
  return startDeliveryRecorder(cliApiContext(hookStoreRoot(root), tenantId), {
    stdinText,
    runtime,
    eventType: 'session-end',
    envSessionId: hostSessionId(),
  });
}

/** What the session-end payload named; null for one hippo refuses or one that never arrived, and the worker then runs
 * with neither value. */
function sessionEndInput(stdinText: string | undefined, timedOut: boolean, runtime: HookRuntime): CaptureInput | null {
  const receipt = readSessionEnd(stdinText, timedOut, runtime);
  if (receipt.status === 'received') return receipt.input;
  log.debug(`session-end: ${receipt.reason}`);
  return null;
}

function sessionEndWorkerArgs(o: SessionEndWorkerInput): string[] {
  const { logFile, transcriptPath, sessionId, turn } = o;
  const workerArgs: string[] = [process.argv[1], '__session-end-worker'];
  if (logFile) workerArgs.push('--log-file', logFile);
  if (transcriptPath) workerArgs.push('--transcript', transcriptPath);
  if (sessionId) workerArgs.push('--session-id', sessionId);
  if (turn) workerArgs.push('--turn');
  return workerArgs;
}

type SessionEndWorkerInput = {
  logFile: string | null;
  transcriptPath: string | null;
  sessionId: string | null;
  turn: boolean;
};

/** The flags the detached worker would parse from its argv, so the inline run sees what the child would have; the
 * hook's own flags fill the gaps. */
function inlineWorkerFlags(flags: CliFlags, w: SessionEndWorkerInput): CliFlags {
  const out: CliFlags = {};
  const keep = (name: string, value: CliFlags[string] | null | undefined): void => {
    if (value) out[name] = value;
  };
  keep('log-file', w.logFile ?? flags['log-file']);
  keep('transcript', w.transcriptPath ?? flags['transcript']);
  keep('session-id', w.sessionId ?? flags['session-id']);
  if (flagIsTrue(flags, 'turn')) out['turn'] = true;
  if (flagIsTrue(flags, 'dry-run')) out['dry-run'] = true;
  if (flagIsTrue(flags, 'no-learn')) out['no-learn'] = true;
  if (flagIsTrue(flags, 'no-share')) out['no-share'] = true;
  return out;
}

function spawnSessionEndWorker(workerArgs: readonly string[]): void {
  const child = spawn(process.execPath, workerArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // An async spawn failure arrives as an 'error' event, which with no listener is an uncaught exception.
  child.on('error', (err) =>
    log.warn(`hippo session-end: the worker did not start: ${errorMessage(err)}`, errorFields(err)),
  );
  child.unref();
}

/** The input of a VS Code Stop payload with a session id that can name the lock file; null makes turn mode a silent
 * no-op. */
function vscodeStopInput(raw: BoundedStdin): CaptureInput | null {
  const receipt = readVscodeStop(raw.text, raw.timedOut);
  return receipt.status === 'received' &&
    receipt.input.sessionId !== null &&
    SESSION_ID_RE.test(receipt.input.sessionId)
    ? receipt.input
    : null;
}

async function cmdSessionEndWorker(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const sessionId = flags['session-id'];
  await runSessionWorker(
    isStringValue(sessionId) ? sessionId : null,
    flagIsTrue(flags, 'turn') ? 'turn' : 'full',
    (mode) => sessionEndWork(hippoRoot, tenantId, flags, mode),
  );
}

export function handleSessionEndWorker({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  return cmdSessionEndWorker(hippoRoot, tenantId, flags);
}

function sessionEndWork(hippoRoot: string, tenantId: string, flags: CliFlags, mode: WorkerMode): Promise<void> {
  const transcriptPath = stringFlag(flags, 'transcript');
  const logFile = stringFlag(flags, 'log-file') ?? null;
  const sessionId = stringFlag(flags, 'session-id') ?? null;
  const logLine = (line: string): void => appendSessionEndCloseLog(logFile, line);
  const ctx = cliApiContext(hippoRoot, tenantId);
  return runSessionEnd<SessionTurn, SessionScan>(ctx, {
    mode,
    sessionId,
    transcriptPath,
    log: (line, opts) => appendSessionEndCloseLog(logFile, line, opts),
    sleep: () => sleepFolderStore(hippoRoot, tenantId, flags, logFile),
    importAgentNotes: () => logSessionEndImport(logFile, tenantId, transcriptPath),
    readScan: (log) => (transcriptPath ? readSessionScan(transcriptPath, log) : null),
    cursor: {
      after: (id, file, turns) => turnsAfter(turns, loadTurnPosition(id, file)),
      save: (id, file, turns) => saveTurnPosition(id, file, turns, logLine),
    },
    currentProject: () => resolveProjectIdentity(process.cwd()),
    capture: (into, turns, originProject) =>
      captureEndedSession(into.hippoRoot, { tenantId, flags, transcriptPath, turns, originProject }),
    digest: (scan, key, log) =>
      recordSessionDigest(hippoRoot, ctx.store, scan, { key, tenantId, log, config: ctx.config }),
    workingState: (log) => (transcriptPath ? transcriptWorkingState(transcriptPath, log) : null),
    evidence: () => collectHandoffEvidence(process.cwd(), 'unknown'),
  });
}

/** Sleeps the folder's own store; a failure goes to the session log, and capture runs regardless. */
async function sleepFolderStore(
  hippoRoot: string,
  tenantId: string,
  flags: CliFlags,
  closeLogFile: string | null,
): Promise<void> {
  try {
    await (await import('./sleep.js')).cmdSleep(hippoRoot, tenantId, flags);
  } catch (err) {
    // cmdSleep writes its own failure line only once its log tee is open.
    reportSessionEndFailure(closeLogFile, 'session-end: sleep', err);
  }
}

interface EndedCapture {
  readonly tenantId: string;
  readonly flags: CliFlags;
  readonly transcriptPath: string | undefined;
  readonly turns: readonly SessionTurn[] | undefined;
  readonly originProject: ProjectRef | undefined;
}

/** True when capture ran to the end, so a turn close may move its cursor past these turns. */
function captureEndedSession(
  store: string,
  { tenantId, flags, transcriptPath, turns, originProject }: EndedCapture,
): boolean {
  const logFile = stringFlag(flags, 'log-file') ?? null;
  try {
    cmdCapture(captureTarget(store), {
      source: 'last-session',
      transcriptPath,
      logFile,
      dryRun: false,
      global: false,
      tenantId,
      originProject,
      sessionTurns: turns,
    });
    return true;
  } catch (err) {
    reportSessionEndFailure(logFile, 'session-end: capture', err);
    return false;
  }
}

function spawnRealCodex(realCodexPath: string, forwardArgs: string[], cwd: string): ReturnType<typeof spawn> {
  const ext = path.extname(realCodexPath).toLowerCase();

  if (process.platform === 'win32' && ext === '.ps1') {
    return spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', realCodexPath, ...forwardArgs],
      { cwd, stdio: 'inherit', windowsHide: false },
    );
  }

  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return spawn('cmd.exe', cmdShimArgs(realCodexPath, forwardArgs), {
      cwd,
      stdio: 'inherit',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(realCodexPath, forwardArgs, { cwd, stdio: 'inherit', windowsHide: false });
}

export function handleCodexRun({ hippoRoot, tenantId, args }: CommandContext): void {
  const realCodexPath = installedRealCodexPath();
  const startedAtMs = Date.now();
  // Codex reads CODEX_HOME at each launch, so resolve it now; the log path is the installer's own, never the file's.
  const { historyPath, logFile } = resolveCodexWrapperPaths();
  const startOffsetBytes = fs.existsSync(historyPath) ? fs.statSync(historyPath).size : 0;

  try {
    cmdLastSleep(hippoRoot, { path: logFile }, 'terminal');
  } catch (err) {
    log.debug(`codex run: the last sleep summary was not shown: ${errorMessage(err)}`, errorFields(err));
  }

  const child = spawnRealCodex(realCodexPath, args, process.cwd());
  child.on('error', (err) => {
    printError(`Failed to launch Codex: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', async (code, signal) => {
    await launchCodexSessionEndWorker({ hippoRoot, tenantId, historyPath, startOffsetBytes, startedAtMs, logFile });
    exitLikeChild(code, signal);
  });
}

interface CodexSessionEndWorkerOptions {
  hippoRoot: string;
  tenantId: string;
  historyPath: string;
  startOffsetBytes: number;
  startedAtMs: number;
  logFile: string;
}

async function launchCodexSessionEndWorker(options: CodexSessionEndWorkerOptions): Promise<void> {
  const { hippoRoot, tenantId, historyPath, startOffsetBytes, startedAtMs, logFile } = options;
  const workerArgs = [
    process.argv[1],
    '__codex-session-end-worker',
    '--codex-home',
    path.dirname(historyPath),
    '--history-path',
    historyPath,
    '--start-offset',
    String(startOffsetBytes),
    '--started-at',
    String(startedAtMs),
    '--log-file',
    logFile,
  ];

  if (await detachedWorkerStarted(workerArgs)) return;
  // Awaited so the sleep write can't be killed by the exit calls below.
  try {
    await cmdCodexSessionEndWorker(hippoRoot, tenantId, {
      'codex-home': path.dirname(historyPath),
      'history-path': historyPath,
      'start-offset': String(startOffsetBytes),
      'started-at': String(startedAtMs),
      'log-file': logFile,
    });
  } catch (inlineErr) {
    log.debug(`codex run: the inline session-end failed: ${errorMessage(inlineErr)}`, errorFields(inlineErr));
  }
}

/**
 * Resolves true once the detached worker is running, false when the spawn fails, whether it throws or reports later.
 */
function detachedWorkerStarted(workerArgs: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const failed = (reason: string): void => {
      log.debug(`codex run: the session-end worker did not spawn, running inline: ${reason}`);
      resolve(false);
    };
    try {
      const worker = spawn(process.execPath, workerArgs, { detached: true, stdio: 'ignore', windowsHide: true });
      // An async spawn failure (ENOENT, EAGAIN) arrives as an 'error' event, which a try cannot catch.
      worker.on('error', (err) => failed(err.message));
      worker.once('spawn', () => resolve(true));
      worker.unref();
    } catch (err) {
      failed(errorMessage(err));
    }
  });
}

function exitLikeChild(code: number | null, signal: NodeJS.Signals | null): void {
  if (signal) {
    // Cannot re-raise the child's signal on this platform; a non-zero exit still reports the failure.
    const raised = ignoringCodes(['ESRCH', 'EPERM', 'ENOSYS', 'ERR_UNKNOWN_SIGNAL'], () =>
      process.kill(process.pid, signal),
    );
    if (raised === undefined) process.exit(1);
    return;
  }
  process.exit(code ?? 0);
}

export async function cmdCodexSessionEndWorker(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const logFile = stringFlag(flags, 'log-file') ?? null;
  // Like the other hooks: project store, else global; a folder with neither must not get one made.
  const store = hookStoreRoot(hippoRoot);
  if (!isInitialized(store)) {
    appendSessionEndCloseLog(logFile, 'skip: no hippo store for this folder or globally', { startFresh: true });
    return;
  }

  await sleepCodexProjectStore(hippoRoot, tenantId, logFile);
  await captureCodexTranscript(hippoRoot, tenantId, store, flags, logFile);
}

export function handleCodexSessionEndWorker({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  return cmdCodexSessionEndWorker(hippoRoot, tenantId, flags);
}

async function sleepCodexProjectStore(hippoRoot: string, tenantId: string, logFile: string | null): Promise<void> {
  // Sleeping the global store from here would learn this folder's git commits into it; it has its own daily sleep.
  if (isInitialized(hippoRoot)) {
    try {
      await (await import('./sleep.js')).cmdSleep(hippoRoot, tenantId, logFile ? { 'log-file': logFile } : {});
    } catch (err) {
      reportSessionEndFailure(logFile, 'codex session-end: sleep', err);
    }
  } else {
    appendSessionEndCloseLog(logFile, 'skip sleep: this folder has no store of its own', { startFresh: true });
    logSessionEndImport(logFile, tenantId, undefined);
  }
}

async function captureCodexTranscript(
  hippoRoot: string,
  tenantId: string,
  store: string,
  flags: CliFlags,
  logFile: string | null,
): Promise<void> {
  try {
    const codexHome = stringFlag(flags, 'codex-home') ?? resolveCodexWrapperPaths().codexHome;
    const historyPath = stringFlag(flags, 'history-path') ?? path.join(codexHome, 'history.jsonl');
    const startOffsetBytes = parseInt(stringFlag(flags, 'start-offset') ?? '', 10) || 0;
    const startedAtMs = parseInt(stringFlag(flags, 'started-at') ?? '', 10) || Date.now();
    const transcriptPath =
      resolveCodexSessionTranscript({
        codexHome,
        historyPath,
        startOffsetBytes,
        startedAtMs,
      }) ?? undefined;
    // No Codex transcript must not fall through to the scan of Claude Code projects.
    if (!transcriptPath) {
      appendSessionEndCloseLog(logFile, 'skip capture: no Codex transcript for this session');
      return;
    }

    const digestLog = (message: string): void => appendSessionEndCloseLog(logFile, message);
    const scan = readSessionScan(transcriptPath, digestLog);
    const captureOpts: CaptureOptions = {
      source: 'last-session',
      transcriptPath,
      logFile,
      dryRun: false,
      global: false,
      tenantId,
      originProject: store === hippoRoot ? undefined : resolveProjectIdentity(process.cwd()),
      sessionTurns: scan?.turns,
    };
    try {
      cmdCapture(captureTarget(store), captureOpts);
    } catch (err) {
      reportSessionEndFailure(logFile, 'codex session-end: capture', err);
    }
    // The Codex wrapper passes no session id, so the rollout file names the session.
    const digestKey = path.basename(transcriptPath, '.jsonl');
    const digestOpts = { key: digestKey, tenantId, log: digestLog, config: cliConfig(hippoRoot) };
    await recordSessionDigest(hippoRoot, cliStore(hippoRoot), scan, digestOpts);
  } catch (err) {
    reportSessionEndFailure(logFile, 'codex session-end: transcript scan or digest', err);
  }
}

export async function handlePreCompact({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  // Bounded wait, not a TTY guard: an idle non-TTY pipe must not hang.
  const { text: stdinText, timedOut: stdinTimedOut } = await readHookStdin();
  const runtime = hookRuntime(flags);
  const root = payloadCwdRoot(hippoRoot, stdinText, runtime);
  const storeRoot = hookStoreRoot(root);
  await cliHookRequest(async () => {
    // Started before any store wait, so two fires of one hook carry timestamps close enough to match as duplicates.
    const rec = startDeliveryRecorder(cliApiContext(storeRoot, tenantId), {
      stdinText,
      runtime,
      eventType: 'pre-compact',
      envSessionId: hostSessionId(),
    });
    resetHookInjection(root, tenantId, stdinText, null);
    await cmdPreCompact(storeRoot, cliStore(storeRoot), {
      tenantId,
      stdinText,
      stdinTimedOut,
      logFile: stringFlag(flags, 'log-file'),
      runtime,
      onBoundary: (printed) => {
        rec?.delivered(printed === null ? { state: 'empty' } : { state: 'sent', emittedText: printed });
        flushDeliveryRecorder(rec);
      },
    });
  });
}

export async function handlePostCompact({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  // PostCompact hook: saves the compaction summary and its memories, then prints one plain line, because Claude Code
  // shows this hook's stdout as-is. Always exits 0.
  const { text, timedOut } = await readHookStdin();
  const logFlag = flags['log-file'];
  const store = hookStoreRoot(hippoRoot);
  const line = await cliHookRequest(() =>
    cmdPostCompact(store, cliStore(store), {
      tenantId,
      stdinText: text,
      stdinTimedOut: timedOut,
      logFile: logFlag === true || logFlag === false || Array.isArray(logFlag) ? undefined : logFlag,
      // Passed in, since src/surface/capture/ importing the sync would close an import cycle.
      afterSave: (transcriptPath, cwd, log) => {
        const sync = cliSyncOptions(store, tenantId, currentMachine(), { busyWaitMs: COMPACTION_DB_WAIT_MS });
        const report = importSessionFolder(store, transcriptPath, cwd, sync);
        const summary = summaryLine(report);
        if (summary !== null) log(summary);
        for (const warning of report.warnings) log(`agent memories: ${warning}`);
      },
    }),
  );
  if (line !== null && line !== undefined) console.log(line);
}

export async function handleCaptureError({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  // PostToolUseFailure hook: every path exits 0, and nothing is created when no store exists (the hook fires in every
  // directory).
  const { text } = await readHookStdin();
  try {
    const root = hookStoreRoot(payloadCwdRoot(hippoRoot, text, hookRuntime(flags)));
    const payload = (text ?? '').trim();
    if (isInitialized(root) && payload) {
      const failure = parseJson(payload);
      const ctx = cliApiContext(root, tenantId);
      const rec = startToolFailureRecorder(ctx, {
        stdinText: text,
        runtime: hookRuntime(flags),
        envSessionId: hostSessionId(),
      });
      await cliHookRequest(async () => {
        try {
          return await captureToolFailure(ctx, failure, (id) => rec?.logged(id));
        } finally {
          flushDeliveryRecorder(rec);
        }
      });
    }
  } catch (err) {
    // A malformed payload or store error must never fail the agent's tool call, so it is reported and dropped.
    log.warn(`failure capture skipped: ${errorMessage(err)}`, errorFields(err));
  }
}

export async function handleCompactResume({ hippoRoot, tenantId }: CommandContext): Promise<void> {
  const { text: stdinText, timedOut: stdinTimedOut } = await readHookStdin();
  await cliHookRequest(async () => {
    resetHookInjection(hippoRoot, tenantId, stdinText, 'compact');
    await cmdCompactResume(hookStoreRoot(hippoRoot), tenantId, stdinText, stdinTimedOut);
  });
}

export async function handleCapture({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  let captureSource: CaptureOptions['source'] | null = null;
  let captureFile: string | undefined;
  let transcriptPath: string | undefined;

  if (flags['stdin']) {
    captureSource = 'stdin';
  } else if (flags['file']) {
    captureSource = 'file';
    captureFile = stringFlagOrExit(flags, 'file');
  } else if (flags['last-session']) {
    captureSource = 'last-session';
  }

  if (flags['transcript']) {
    transcriptPath = stringFlagOrExit(flags, 'transcript');
    if (!captureSource) captureSource = 'last-session';
  }

  if (!captureSource) {
    fail(
      'Usage: hippo capture --stdin|--file <path>|--last-session [--transcript <path>] [--log-file <path>] ' +
        '[--dry-run] [--global]',
    );
  }

  // Bounded, and only when last-session has no explicit path: the --stdin source keeps its own blocking read in
  // src/surface/capture/ by design.
  const bounded =
    captureSource === 'last-session' && !transcriptPath ? await readHookStdin() : { text: undefined, timedOut: false };

  const useGlobal = boolFlag(flags, 'global');
  cmdCapture(captureTarget(useGlobal ? getGlobalRoot() : hippoRoot), {
    source: captureSource,
    filePath: captureFile,
    transcriptPath,
    stdinText: bounded.text,
    stdinTimedOut: bounded.timedOut,
    logFile: stringFlag(flags, 'log-file'),
    dryRun: boolFlag(flags, 'dry-run'),
    global: useGlobal,
    tenantId,
  });
}
