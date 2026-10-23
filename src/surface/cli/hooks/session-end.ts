// The SessionEnd hook: reads the payload inline, then hands the slow work to a detached worker before the host exits.
import * as fs from 'fs';
import { spawn } from 'child_process';
import { resolveJsonHookPaths } from '../../hooks-install/json-hooks.js';
import { copilotTranscriptFor, SESSION_ID_RE } from '../../capture/copilot-transcript.js';
import {
  readSessionEnd,
  readVscodeStop,
  type CaptureInput,
  type HookRuntime,
} from '../../../base/session/capture-contract.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { flushDeliveryRecorder, startDeliveryRecorder } from '../../../api/prompt-hook.js';
import type { DeliveryRecorder } from '../../../api/delivery-recorder.js';
import { normalizeHookPayload, readStdinBounded, type BoundedStdin } from '../stdin.js';
import { cliApiContext, cliHookRequest } from '../api-context.js';
import { type CliFlags, type CommandContext, boolFlag, stringFlag } from '../flag-values.js';
import { hookRuntime, hookStoreRoot, hostSessionId, payloadCwdRoot } from '../hook-runtime.js';
import { handleSessionEndWorker } from './session-end-worker.js';

/** SessionEnd entry: TUI teardown kills children still running, so read stdin inline, spawn a detached child that runs
 * sleep then capture, and exit. The child logs to a file that the next SessionStart reads via `hippo last-sleep`. */
export async function handleSessionEnd({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const runtime = hookRuntime(flags);
  const turn = boolFlag(flags, 'turn');
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
    !turn && input !== null && !input.manual ? await startSessionEndRecorder(root, tenantId, stdinText, runtime) : null;
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
      await handleSessionEndWorker({ hippoRoot: root, tenantId, args: [], flags: inlineWorkerFlags(flags, worker) });
    } finally {
      await cliHookRequest(() => flushDeliveryRecorder(rec));
    }
    return;
  }
  // After the spawn, so a locked store delays only the row; the hook's short lock wait bounds it.
  await cliHookRequest(() => flushDeliveryRecorder(rec));
}

async function startSessionEndRecorder(
  root: string,
  tenantId: string,
  stdinText: string | undefined,
  runtime: HookRuntime,
): Promise<DeliveryRecorder | null> {
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
  keep('log-file', w.logFile ?? stringFlag(flags, 'log-file'));
  keep('transcript', w.transcriptPath ?? stringFlag(flags, 'transcript'));
  keep('session-id', w.sessionId ?? stringFlag(flags, 'session-id'));
  if (boolFlag(flags, 'turn')) out['turn'] = true;
  if (boolFlag(flags, 'dry-run')) out['dry-run'] = true;
  if (boolFlag(flags, 'no-learn')) out['no-learn'] = true;
  if (boolFlag(flags, 'no-share')) out['no-share'] = true;
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
