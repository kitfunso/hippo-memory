// Agent lifecycle hook verbs: session end, compaction, tool-failure capture and the Codex wrapper.

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { resolveCodexSessionTranscript } from '../hooks/codex-session.js';
import { resolveCodexWrapperPaths, type CodexWrapperMetadata } from '../hooks/codex-wrapper.js';
import { resolveJsonHookPaths } from '../hooks/json-hooks.js';
import { SessionEvent } from '../store/rows.js';
import { isInitialized } from '../store/open.js';
import {
  loadActiveTaskSnapshot,
  loadFreshActiveTaskSnapshot,
  closeTaskSnapshotsForSession,
  listSessionEvents,
} from '../store/sessions.js';
import { writeSessionEndHandoff } from '../store/handoffs.js';
import { readSessionScan, recordSessionDigest } from '../session-digest.js';
import { openHippoDb, closeHippoDb } from '../db.js';
import { captureToolFailure } from '../capture-error.js';
import {
  estimateTokens,
  isSubagentPayload,
  readApiCalls,
  recordRereads,
  recordTokenUse,
  type TranscriptCalls,
} from '../token-ledger.js';
import { currentMachine, importSessionFolder } from '../agent-memories/sync.js';
import { summaryLine } from '../agent-memories/report.js';
import { resolveProjectIdentity } from '../project-identity.js';
import { getGlobalRoot } from '../shared.js';
import { cmdCapture, CaptureOptions } from '../capture/command.js';
import { cmdPreCompact, cmdPostCompact } from '../capture/compact.js';
import { transcriptWorkingState } from '../capture/working-state.js';
import { collectHandoffEvidence } from '../handoff-evidence.js';
import { resolveLastSessionTranscript, type SessionTurn } from '../capture/transcript.js';
import { copilotTranscriptFor, SESSION_ID_RE } from '../capture/copilot-transcript.js';
import { loadTurnPosition, runSessionWorker, saveTurnPosition, turnsAfter, type WorkerMode } from '../capture/session-worker.js';
import { isStringValue, readVscodeStop } from '../capture-contract.js';
import { loadConfig } from '../config.js';
import { countCreatedSinceLastSleep } from '../store/index-and-stats.js';
import { truncateCodePointSafe } from '../transcript-tail.js';
import { COMPACTION_DB_WAIT_MS } from '../compaction-record.js';
import { COMPACT_RESUME_EVENT_CONTENT_CAP, COMPACT_RESUME_MAX_AGE_MS, compactResumeText } from '../context-render.js';
import { normaliseHookPayload, readHookStdin, readStdinBounded, type BoundedStdin } from '../stdin.js';
import { resolveTenantId } from '../tenant.js';
import { errorMessage, log } from '../log.js';
import { withLedgerDb } from '../ledger-db.js';
import { flushDeliveryRecorder } from '../prompt-hook.js';
import type { DeliveryRecorder } from '../delivery-recorder.js';
import { printError } from './output.js';
import { cmdLastSleep } from './last-sleep.js';
import {
  type CommandContext,
  logSessionEndImport,
  appendSessionEndCloseLog,
  resetHookInjection,
  hookStoreRoot,
  hookRuntime,
  payloadCwdRoot,
  runHookWithStores,
  inPilotHoldout,
  startDeliveryRecorder,
} from './shared.js';
import type { JsonValue } from '../json.js';

/**
 * SessionStart(compact) injector. Prints the active task snapshot + recent
 * session trail so working state that would otherwise be lost to
 * compaction summarisation survives into the new context window. No pinned
 * memories here — the UserPromptSubmit hook already re-injects those every
 * turn, so duplicating them here would double token cost for nothing.
 *
 * Same exit-0/crash-safety contract as `hippo pre-compact`: every path
 * exits 0. A malformed payload or a store read failure
 * degrades to empty stdout, never a thrown error — a failing SessionStart
 * hook must not pollute session startup.
 */
function cmdCompactResume(hippoRoot: string, stdinText: string | undefined, stdinTimedOut: boolean): void {
  let rec: DeliveryRecorder | null = null;
  try {
    // Gate on the non-exiting isInitialized check first: the store reads below call initStore, which would
    // silently create a store in a project that never ran `hippo init`, and this hook fires globally.
    if (!isInitialized(hippoRoot)) {
      process.exit(0);
    }

    // The matcher is an optimization, not a dependency: older Claude Code
    // that ignores `matcher: 'compact'` would run this on every SessionStart,
    // so we also gate on payload.source here. A payload that parses but
    // carries a different source (e.g. 'startup') means the matcher-based
    // gate failed to apply — stay silent rather than print stale state.
    const nonEmptyStdin = !!stdinText && stdinText.trim() !== '';
    // Without a payload session_id the cross-restore guard below can
    // never fire, so a timed-out empty read must not reach the print path.
    let suppressOutput = stdinTimedOut && !nonEmptyStdin;
    let payloadSessionId: string | null = null;
    // A boundary is a manual run or a payload that says it follows a compaction; anything else is not one.
    let boundary = !nonEmptyStdin && !stdinTimedOut;

    if (nonEmptyStdin) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(stdinText!.trim()) as Record<string, unknown>;
      } catch {
        // Malformed JSON is handled as a null payload by the fail-closed check below.
        payload = null;
      }
      if (!payload || typeof payload !== 'object') {
        // Fail closed on malformed non-empty stdin; only a TTY/no-stdin manual run, which never reaches here, prints.
        suppressOutput = true;
      } else {
        // Fail closed on structurally incomplete payloads too ({}, [], source missing/non-string): real
        // SessionStart payloads always carry source, so a parsed one must say 'compact' to print.
        // A sub-agent's payload carries its parent's session id, so the mismatch guard would pass and restore the parent's snapshot into it.
        boundary = payload.source === 'compact';
        if (payload.source !== 'compact' || isSubagentPayload(stdinText)) {
          suppressOutput = true;
        }
        if (typeof payload.session_id === 'string') {
          payloadSessionId = payload.session_id;
        }
      }
    }

    if (boundary) rec = startDeliveryRecorder(hippoRoot, stdinText, 'claude-code', 'compact-resume');

    // A compaction follows a prompt or SessionStart that booked the arm, so this only reads it.
    if (!suppressOutput && payloadSessionId !== null && inPilotHoldout(hippoRoot, resolveTenantId({}), payloadSessionId, false)) {
      suppressOutput = true;
      rec?.disabled();
    }

    if (!suppressOutput) restoreCompactSnapshot(hippoRoot, payloadSessionId, rec);
  } catch (err) {
    // Empty stdout on any store error, never a crashed SessionStart; the reason goes to stderr, which the model never sees.
    log.warn(`hippo compact-resume: skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A no-op when the token ledger's handle already wrote the row; exit would drop it otherwise.
  flushDeliveryRecorder(rec);
  process.exit(0);
}

function restoreCompactSnapshot(hippoRoot: string, payloadSessionId: string | null, rec: DeliveryRecorder | null): void {
  const tenantId = resolveTenantId({});
  const snapshot = loadFreshActiveTaskSnapshot(hippoRoot, tenantId, { maxAgeMs: COMPACT_RESUME_MAX_AGE_MS });
  // Concurrent sessions must not cross-restore. Only suppress when BOTH ids are present and differ;
  // either side missing, or a manual invocation with no payload session_id, still prints.
  const sessionMismatch =
    !!snapshot &&
    payloadSessionId !== null &&
    snapshot.session_id !== null &&
    payloadSessionId !== snapshot.session_id;

  if (!snapshot || sessionMismatch) return;
  // Loaded before the print so a bad trail row costs the trail, not the snapshot; stderr stays out of the model's context.
  let events: SessionEvent[] = [];
  try {
    if (snapshot.session_id) {
      events = listSessionEvents(hippoRoot, tenantId, { session_id: snapshot.session_id }).map((e) => ({
        ...e,
        content: truncateCodePointSafe(e.content, COMPACT_RESUME_EVENT_CONTENT_CAP),
      }));
    }
  } catch (err) {
    log.warn(`hippo compact-resume: trail skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Printed in one write so the ledger books exactly the text the model is handed.
  const text = compactResumeText(snapshot, events);
  console.log(text);
  rec?.delivered({ state: 'sent', emittedText: `${text}\n` });
  withLedgerDb(hippoRoot, (db) => {
    recordTokenUse(db, {
      tenantId, sessionId: payloadSessionId, surface: 'compact_resume', event: 'inject', items: 1, tokens: estimateTokens(text),
    });
    flushDeliveryRecorder(rec, db);
  });
}

/**
 * SessionEnd entry point. Claude Code / OpenCode fire this on /exit while
 * tearing down the TUI, which kills any child that is still running when
 * the parent returns. Running sleep + capture synchronously here means both
 * get SIGTERM'd mid-consolidation.
 *
 * So we do the minimum inline (read stdin for transcript_path), then spawn
 * a fully detached Node child that runs sleep → capture and exit the parent
 * immediately. The child writes to the log file and survives TUI teardown;
 * the next SessionStart reads the log via `hippo last-sleep`.
 */
export async function cmdSessionEnd(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  const runtime = hookRuntime(flags);
  const turn = flags['turn'] === true;
  // Copilot's hook command carries no path, since one quoted into it would need escaping for each shell; the log goes where the hook table used to point.
  const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : runtime === 'copilot' ? resolveJsonHookPaths('copilot').logFile : null;

  // Bounded read: extracts transcript_path + session_id for the detached worker's argv.
  let sessionId: string | null = null;
  const raw = await readStdinBounded();
  // Read before normalising: the Copilot CLI's agentStop shares this hook line, and camelCase keys would pass as VS Code's.
  if (turn && !isVscodeStopPayload(raw)) return;
  const stdinText = normaliseHookPayload(raw.text);
  // Before the spawn, since the worker finds its store from the folder it inherits.
  const root = payloadCwdRoot(hippoRoot, stdinText, runtime);
  try {
    if (stdinText && stdinText.trim().startsWith('{')) {
      const payload = JSON.parse(stdinText) as Record<string, unknown>;
      if (typeof payload.session_id === 'string') {
        sessionId = payload.session_id;
      }
    }
  } catch {
    // No stdin, not JSON, or read failure: the snapshot close below will no-op.
  }
  // Resolved here because only this process saw the payload; the worker captures just the path it is handed.
  // Always a hook, so never scan: an empty stdin here is not a manual run. The Copilot CLI's sessionEnd names no transcript, so its log is found by id.
  const transcriptPath = resolveLastSessionTranscript(undefined, stdinText, { mayScan: false })
    ?? (runtime === 'copilot' && sessionId ? copilotTranscriptFor(sessionId) : null);

  const workerArgs: string[] = [process.argv[1], '__session-end-worker'];
  if (logFile) workerArgs.push('--log-file', logFile);
  if (transcriptPath) workerArgs.push('--transcript', transcriptPath);
  if (sessionId) workerArgs.push('--session-id', sessionId);
  if (turn) workerArgs.push('--turn');

  try {
    const child = spawn(process.execPath, workerArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // An async spawn failure arrives as an 'error' event, which with no listener is an uncaught exception.
    child.on('error', (err) => log.warn(`hippo session-end: the worker did not start: ${errorMessage(err)}`));
    child.unref();
  } catch (err) {
    log.debug(`session-end: the worker did not spawn, running inline: ${errorMessage(err)}`);
    // Inline is the last resort, handed what the child's argv would have carried.
    if (logFile) flags['log-file'] = logFile;
    if (transcriptPath) flags['transcript'] = transcriptPath;
    if (sessionId) flags['session-id'] = sessionId;
    await cmdSessionEndWorker(root, flags);
    return;
  }
}

/** A VS Code Stop payload with a session id that can name the lock file; anything else makes turn mode a silent no-op. */
function isVscodeStopPayload(raw: BoundedStdin): boolean {
  const receipt = readVscodeStop(raw.text, raw.timedOut);
  return receipt.status === 'received' && receipt.input.sessionId !== null && SESSION_ID_RE.test(receipt.input.sessionId);
}

export async function cmdSessionEndWorker(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  const sessionId = flags['session-id'];
  await runSessionWorker(isStringValue(sessionId) ? sessionId : null, flags['turn'] === true ? 'turn' : 'full', (mode) => sessionEndWork(hippoRoot, flags, mode));
}

async function sessionEndWork(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
  mode: WorkerMode,
): Promise<void> {
  const transcriptPath = typeof flags['transcript'] === 'string' ? (flags['transcript'] as string) : undefined;
  const closeLogFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : null;
  const closeSessionId = typeof flags['session-id'] === 'string' ? (flags['session-id'] as string) : null;
  const rereadLog = await bookSessionRereads(hippoRoot, transcriptPath, closeSessionId)
    .catch((err) => [`re-read count failed: ${err instanceof Error ? err.message : String(err)}`]);
  // Sleep starts the log file afresh, so the lines go in after it; on exit too, in case sleep exits the process.
  const flushRereadLog = (): void => { for (const line of rereadLog.splice(0)) appendSessionEndCloseLog(closeLogFile, line); };
  process.once('exit', flushRereadLog);
  // Like the other hooks: project store, else global; a folder with neither must not get one made.
  const store = hookStoreRoot(hippoRoot);
  if (!isInitialized(store)) {
    appendSessionEndCloseLog(closeLogFile, 'skip: no hippo store for this folder or globally', { startFresh: true });
    flushRereadLog();
    return;
  }
  if (mode === 'turn' && closeSessionId) await sleepIfDue(hippoRoot, flags, closeLogFile, transcriptPath, closeSessionId);
  else await sleepProjectStore(hippoRoot, flags, closeLogFile, transcriptPath);
  flushRereadLog();
  const digestLog = (message: string): void => appendSessionEndCloseLog(closeLogFile, message);
  const scan = transcriptPath ? readSessionScan(transcriptPath, digestLog) : null;
  const capture = (turns: readonly SessionTurn[] | undefined): boolean => captureEndedSession(hippoRoot, store, flags, transcriptPath, turns);
  if (mode === 'turn') captureNewTurns(transcriptPath, closeSessionId, scan, capture, digestLog);
  else capture(scan?.turns);
  recordSessionDigest(hippoRoot, scan, {
    key: closeSessionId || path.basename(transcriptPath ?? '', '.jsonl'),
    tenantId: resolveTenantId({}),
    log: digestLog,
  });

  // Close only this session's snapshot, after sleep+capture: no snapshot producer runs in session-end, and since
  // session-end may never fire (crash, kill -9) the freshness bound in loadFreshActiveTaskSnapshot is the backstop.
  // The handoff is written first, while the snapshot writeSessionEndHandoff reads is still active.
  if (closeSessionId) writeEndHandoff(store, closeSessionId, transcriptPath, closeLogFile, mode === 'turn');
  if (mode === 'turn') {
    // The chat goes on after a reply, so its snapshot stays for the next compaction to restore.
    appendSessionEndCloseLog(closeLogFile, 'skip snapshot close: turn mode');
    return;
  }
  try {
    if (closeSessionId) {
      const closed = closeTaskSnapshotsForSession(store, resolveTenantId({}), closeSessionId);
      appendSessionEndCloseLog(closeLogFile, `closed ${closed} active snapshot(s) for session ${closeSessionId}`);
    } else {
      appendSessionEndCloseLog(closeLogFile, 'skip: no session_id in SessionEnd payload, active snapshot left untouched');
    }
  } catch (err) {
    appendSessionEndCloseLog(closeLogFile, `snapshot close failed: ${(err as Error).message}`);
  }
}

async function sleepProjectStore(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
  closeLogFile: string | null,
  transcriptPath: string | undefined,
): Promise<void> {
  // Sleeping the global store from here would learn this folder's git commits into it; it has its own daily sleep.
  if (isInitialized(hippoRoot)) {
    try {
      await (await import('./sleep.js')).cmdSleep(hippoRoot, flags);
    } catch (err) {
      // cmdSleep writes its failure line only when it has a log file, and capture runs regardless.
      log.debug(`session-end: sleep failed: ${errorMessage(err)}`);
    }
  } else {
    appendSessionEndCloseLog(closeLogFile, 'skip sleep: this folder has no store of its own', { startFresh: true });
    logSessionEndImport(closeLogFile, transcriptPath);
  }
}

/** A close after every reply sleeps only at the MCP server's auto-sleep threshold; each line starts the log afresh, as a sleep does. */
async function sleepIfDue(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
  closeLogFile: string | null,
  transcriptPath: string | undefined,
  sessionId: string,
): Promise<void> {
  if (!isInitialized(hippoRoot)) return sleepProjectStore(hippoRoot, flags, closeLogFile, transcriptPath);
  const prefix = `turn close, session ${sessionId}`;
  try {
    const { enabled, threshold } = loadConfig(hippoRoot).autoSleep;
    const count = enabled ? countCreatedSinceLastSleep(hippoRoot, resolveTenantId({})) : 0;
    if (!enabled || count < threshold) {
      const why = enabled ? `${count} new memories, threshold ${threshold}` : 'auto-sleep is off';
      appendSessionEndCloseLog(closeLogFile, `${prefix}: skip sleep, ${why}`, { startFresh: true });
      return;
    }
    await sleepProjectStore(hippoRoot, flags, closeLogFile, transcriptPath);
    appendSessionEndCloseLog(closeLogFile, `${prefix}: ran sleep at ${count} new memories (threshold ${threshold})`);
  } catch (err) {
    appendSessionEndCloseLog(closeLogFile, `${prefix}: sleep check failed: ${errorMessage(err)}`, { startFresh: true });
  }
}

/** Captures only the turns after this session's cursor, then moves the cursor, so each reply is extracted once. */
function captureNewTurns(
  transcriptPath: string | undefined,
  sessionId: string | null,
  scan: ReturnType<typeof readSessionScan>,
  capture: (turns: readonly SessionTurn[]) => boolean,
  log: (message: string) => void,
): void {
  if (!transcriptPath || !sessionId || !scan) {
    log('skip capture: no readable transcript for this session');
    return;
  }
  const fresh = turnsAfter(scan.turns, loadTurnPosition(sessionId, transcriptPath));
  if (fresh.length === 0) {
    log('skip capture: no new turns since the last reply');
    return;
  }
  if (capture(fresh)) saveTurnPosition(sessionId, transcriptPath, scan.turns, log);
}

/** True when capture ran to the end, so a turn close may move its cursor past these turns. */
function captureEndedSession(
  hippoRoot: string,
  store: string,
  flags: Record<string, string | boolean | string[]>,
  transcriptPath: string | undefined,
  turns: readonly SessionTurn[] | undefined,
): boolean {
  try {
    const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : undefined;
    // With no stdin of its own, capture would read this as a manual run and scan every project.
    if (!transcriptPath) {
      appendSessionEndCloseLog(logFile ?? null, 'skip capture: no transcript for this session');
      return false;
    }
    cmdCapture(store, {
      source: 'last-session',
      transcriptPath,
      logFile,
      dryRun: false,
      global: false,
      tenantId: resolveTenantId({}),
      // In the global store, rows would otherwise read as user-global and show up in every project.
      originProject: store === hippoRoot ? undefined : resolveProjectIdentity(process.cwd()),
      sessionTurns: turns,
    });
    return true;
  } catch (err) {
    log.debug(`session-end: capture failed: ${errorMessage(err)}`);
    return false;
  }
}

function writeEndHandoff(
  store: string,
  closeSessionId: string,
  transcriptPath: string | undefined,
  closeLogFile: string | null,
  inPlace = false,
): void {
  try {
    const tenantId = resolveTenantId({});
    const ownSnapshot = loadActiveTaskSnapshot(store, tenantId)?.session_id === closeSessionId;
    // A never-compacted session has no snapshot; read even when it has one, as another session's PreCompact can take the slot before the write.
    const derived = transcriptPath
      ? transcriptWorkingState(transcriptPath, (message) => appendSessionEndCloseLog(closeLogFile, message))
      : null;
    if (!ownSnapshot && !derived) {
      appendSessionEndCloseLog(closeLogFile, 'skip: no snapshot or transcript for session');
    } else {
      const evidence = collectHandoffEvidence(process.cwd(), 'unknown');
      const handoff = writeSessionEndHandoff(store, tenantId, closeSessionId, evidence, derived, undefined, { inPlace });
      appendSessionEndCloseLog(
        closeLogFile,
        handoff ? `wrote handoff for session ${closeSessionId}` : `skip: kept the existing handoff for session ${closeSessionId}`,
      );
    }
  } catch (err) {
    // SAFETY: catch clauses bind unknown, but Node/V8 always throws an Error here.
    appendSessionEndCloseLog(closeLogFile, `handoff write failed: ${(err as Error).message}`);
  }
}

/** Books the ending session's re-reads in each store its ledger rows can land in (project and global); returns the log lines. */
async function bookSessionRereads(
  hippoRoot: string,
  transcriptPath: string | undefined,
  sessionId: string | null,
): Promise<string[]> {
  if (!transcriptPath || !sessionId) return [];
  let read: TranscriptCalls;
  try {
    read = await readApiCalls(transcriptPath);
  } catch (err) {
    return [`skip re-read count: cannot read the transcript: ${err instanceof Error ? err.message : String(err)}`];
  }
  const roots = new Set([hippoRoot, getGlobalRoot()].filter((root) => isInitialized(root)).map((root) => path.resolve(root)));
  const lines: string[] = [];
  let tokens = 0;
  for (const root of roots) {
    try {
      const db = openHippoDb(root);
      try {
        tokens += recordRereads(db, resolveTenantId({}), sessionId, read.calls);
      } finally {
        closeHippoDb(db);
      }
    } catch (err) {
      lines.push(`re-read count failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const skipped = read.malformed > 0 ? `, ${read.malformed} unparsable transcript lines skipped` : '';
  lines.push(`re-read ${tokens} tokens over ${read.calls.length} model calls for session ${sessionId}${skipped}`);
  return lines;
}

function loadCodexWrapperMetadata(): CodexWrapperMetadata {
  const { metadataPath } = resolveCodexWrapperPaths();
  if (!fs.existsSync(metadataPath)) {
    throw new Error('Codex wrapper is not installed. Run `hippo hook install codex` first.');
  }
  return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as CodexWrapperMetadata;
}

/** Quotes one cmd.exe argument; each `%` leaves the quotes as `^%`, so no %NAME% pair can expand. */
export function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"&()^<>|%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""').replace(/%/g, '"^%"')}"`;
}

/** cmd.exe arguments that run a .cmd or .bat shim with every forwarded argument delivered verbatim. */
export function cmdShimArgs(shimPath: string, forwardArgs: readonly string[]): string[] {
  const command = `"${shimPath}"${forwardArgs.length > 0 ? ` ${forwardArgs.map(quoteCmdArg).join(' ')}` : ''}`;
  // The line is already quoted for cmd.exe, so Node must not quote it again; /s strips the outer pair.
  return ['/d', '/v:off', '/s', '/c', `"${command}"`];
}

function spawnRealCodex(
  realCodexPath: string,
  forwardArgs: string[],
  cwd: string,
): ReturnType<typeof spawn> {
  const ext = path.extname(realCodexPath).toLowerCase();

  if (process.platform === 'win32' && ext === '.ps1') {
    return spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', realCodexPath, ...forwardArgs],
      { cwd, stdio: 'inherit', windowsHide: false },
    );
  }

  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return spawn(
      'cmd.exe',
      cmdShimArgs(realCodexPath, forwardArgs),
      { cwd, stdio: 'inherit', windowsHide: false, windowsVerbatimArguments: true },
    );
  }

  return spawn(realCodexPath, forwardArgs, { cwd, stdio: 'inherit', windowsHide: false });
}

export function cmdCodexRun(
  hippoRoot: string,
  args: string[],
): void {
  const metadata = loadCodexWrapperMetadata();
  const startedAtMs = Date.now();
  // Codex reads CODEX_HOME at each launch, so resolve it now, not from the install-time metadata.
  const { historyPath } = resolveCodexWrapperPaths();
  const startOffsetBytes = fs.existsSync(historyPath) ? fs.statSync(historyPath).size : 0;

  try {
    cmdLastSleep(hippoRoot, { path: metadata.logFile }, 'terminal');
  } catch (err) {
    log.debug(`codex run: the last sleep summary was not shown: ${errorMessage(err)}`);
  }

  const child = spawnRealCodex(metadata.realCodexPath, args, process.cwd());
  child.on('error', (err) => {
    printError(`Failed to launch Codex: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', async (code, signal) => {
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
      metadata.logFile,
    ];

    try {
      const worker = spawn(process.execPath, workerArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      worker.unref();
    } catch (err) {
      log.debug(`codex run: the session-end worker did not spawn, running inline: ${errorMessage(err)}`);
      // Awaited so the sleep write can't be killed by the exit calls below.
      try {
        await cmdCodexSessionEndWorker(hippoRoot, {
          'codex-home': path.dirname(historyPath),
          'history-path': historyPath,
          'start-offset': String(startOffsetBytes),
          'started-at': String(startedAtMs),
          'log-file': metadata.logFile,
        });
      } catch (inlineErr) {
        log.debug(`codex run: the inline session-end failed: ${errorMessage(inlineErr)}`);
      }
    }

    if (signal) {
      try {
        process.kill(process.pid, signal);
      } catch {
        // Cannot re-raise the child's signal on this platform; a non-zero exit still reports the failure.
        process.exit(1);
      }
      return;
    }
    process.exit(code ?? 0);
  });
}

export async function cmdCodexSessionEndWorker(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): Promise<void> {
  const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : undefined;
  // Like the other hooks: project store, else global; a folder with neither must not get one made.
  const store = hookStoreRoot(hippoRoot);
  if (!isInitialized(store)) {
    appendSessionEndCloseLog(logFile ?? null, 'skip: no hippo store for this folder or globally', { startFresh: true });
    return;
  }

  // Sleeping the global store from here would learn this folder's git commits into it; it has its own daily sleep.
  if (isInitialized(hippoRoot)) {
    try {
      await (await import('./sleep.js')).cmdSleep(hippoRoot, logFile ? { 'log-file': logFile } : {});
    } catch (err) {
      log.debug(`codex session-end: sleep failed: ${errorMessage(err)}`);
    }
  } else {
    appendSessionEndCloseLog(logFile ?? null, 'skip sleep: this folder has no store of its own', { startFresh: true });
    logSessionEndImport(logFile ?? null, undefined);
  }

  try {
    const codexHome = typeof flags['codex-home'] === 'string'
      ? (flags['codex-home'] as string)
      : resolveCodexWrapperPaths().codexHome;
    const historyPath = typeof flags['history-path'] === 'string'
      ? (flags['history-path'] as string)
      : path.join(codexHome, 'history.jsonl');
    const startOffsetBytes = parseInt(String(flags['start-offset'] ?? '0'), 10) || 0;
    const startedAtMs = parseInt(String(flags['started-at'] ?? Date.now()), 10) || Date.now();
    const transcriptPath = resolveCodexSessionTranscript({
      codexHome,
      historyPath,
      startOffsetBytes,
      startedAtMs,
    }) ?? undefined;
    // No Codex transcript must not fall through to the scan of Claude Code projects.
    if (!transcriptPath) {
      appendSessionEndCloseLog(logFile ?? null, 'skip capture: no Codex transcript for this session');
      return;
    }

    const digestLog = (message: string): void => appendSessionEndCloseLog(logFile ?? null, message);
    const scan = readSessionScan(transcriptPath, digestLog);
    const captureOpts: CaptureOptions = {
      source: 'last-session',
      transcriptPath,
      logFile,
      dryRun: false,
      global: false,
      tenantId: resolveTenantId({}),
      originProject: store === hippoRoot ? undefined : resolveProjectIdentity(process.cwd()),
      sessionTurns: scan?.turns,
    };
    try {
      cmdCapture(store, captureOpts);
    } catch (err) {
      log.debug(`codex session-end: capture failed: ${errorMessage(err)}`);
    }
    // The Codex wrapper passes no session id, so the rollout file names the session.
    recordSessionDigest(hippoRoot, scan, { key: path.basename(transcriptPath, '.jsonl'), tenantId: resolveTenantId({}), log: digestLog });
  } catch (err) {
    log.debug(`codex session-end: transcript scan or digest failed: ${errorMessage(err)}`);
  }
}

export async function handlePreCompact({ hippoRoot, flags }: CommandContext): Promise<void> {
  // Bounded wait, not a TTY guard: an idle non-TTY pipe must not hang.
  const { text: stdinText, timedOut: stdinTimedOut } = await readHookStdin();
  const runtime = hookRuntime(flags);
  const root = payloadCwdRoot(hippoRoot, stdinText, runtime);
  await runHookWithStores(async () => {
    // Started before any store wait, so two fires of one hook carry timestamps close enough to match as duplicates.
    const rec = startDeliveryRecorder(hookStoreRoot(root), stdinText, runtime, 'pre-compact');
    resetHookInjection(root, stdinText, null);
    await cmdPreCompact(hookStoreRoot(root), {
      stdinText,
      stdinTimedOut,
      logFile: typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : undefined,
      runtime,
      onBoundary: (printed) => {
        rec?.delivered(printed === null ? { state: 'empty' } : { state: 'sent', emittedText: printed });
        flushDeliveryRecorder(rec);
      },
    });
  });
}

export async function handlePostCompact({ hippoRoot, flags }: CommandContext): Promise<void> {
  // PostCompact hook: saves the compaction summary and its memories, then prints one plain line, because Claude Code shows this hook's stdout as-is. Always exits 0.
  const { text } = await readHookStdin();
  const logFlag = flags['log-file'];
  const store = hookStoreRoot(hippoRoot);
  const line = await runHookWithStores(() => cmdPostCompact(store, {
    stdinText: text,
    logFile: logFlag === true || logFlag === false || Array.isArray(logFlag) ? undefined : logFlag,
    // Passed in, since capture.ts importing the sync would close an import cycle.
    afterSave: (transcriptPath, cwd, log) => {
      const report = importSessionFolder(store, transcriptPath, cwd, { machine: currentMachine(), busyWaitMs: COMPACTION_DB_WAIT_MS });
      const summary = summaryLine(report);
      if (summary !== null) log(summary);
      for (const warning of report.warnings) log(`agent memories: ${warning}`);
    },
  }));
  if (line !== null && line !== undefined) console.log(line);
}

export async function handleCaptureError({ hippoRoot, flags }: CommandContext): Promise<void> {
  // PostToolUseFailure hook: every path exits 0, and nothing is created
  // when no store exists (the hook fires in every directory).
  const { text } = await readHookStdin();
  try {
    const root = hookStoreRoot(payloadCwdRoot(hippoRoot, text, hookRuntime(flags)));
    const payload = (text ?? '').trim();
    if (isInitialized(root) && payload) {
      // SAFETY: JSON.parse returns a JSON value by definition.
      const failure = JSON.parse(payload) as JsonValue;
      await runHookWithStores(() => captureToolFailure(root, resolveTenantId({}), failure));
    }
  } catch (err) {
    // A malformed payload or store error must never fail the agent's tool call, so it is reported and dropped.
    log.warn(`failure capture skipped: ${errorMessage(err)}`);
  }
}

export async function handleCompactResume({ hippoRoot }: CommandContext): Promise<void> {
  const { text: stdinText, timedOut: stdinTimedOut } = await readHookStdin();
  await runHookWithStores(() => {
    resetHookInjection(hippoRoot, stdinText, 'compact');
    cmdCompactResume(hookStoreRoot(hippoRoot), stdinText, stdinTimedOut);
  });
}

export async function handleCapture({ hippoRoot, flags }: CommandContext): Promise<void> {
  let captureSource: CaptureOptions['source'] | null = null;
  let captureFile: string | undefined;
  let transcriptPath: string | undefined;

  if (flags['stdin']) { captureSource = 'stdin'; }
  else if (flags['file']) { captureSource = 'file'; captureFile = String(flags['file']); }
  else if (flags['last-session']) { captureSource = 'last-session'; }

  if (flags['transcript']) {
    transcriptPath = String(flags['transcript']);
    if (!captureSource) captureSource = 'last-session';
  }

  if (!captureSource) {
    printError('Usage: hippo capture --stdin|--file <path>|--last-session [--transcript <path>] [--log-file <path>] [--dry-run] [--global]');
    process.exit(1);
  }

  // Bounded, and only when last-session has no explicit path: the
  // --stdin source keeps its own blocking read in capture.ts by design.
  const bounded = captureSource === 'last-session' && !transcriptPath
    ? await readHookStdin()
    : { text: undefined, timedOut: false };

  cmdCapture(hippoRoot, {
    source: captureSource,
    filePath: captureFile,
    transcriptPath,
    stdinText: bounded.text,
    stdinTimedOut: bounded.timedOut,
    logFile: typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : undefined,
    dryRun: Boolean(flags['dry-run']),
    global: Boolean(flags['global']),
    tenantId: resolveTenantId({}),
  });
}
