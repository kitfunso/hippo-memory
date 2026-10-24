// What the hook commands share: session id, store choice, delivery recorder, session-end log and store-busy handling.

import { envClaudeCodeSessionId, envHippoSessionId } from '../../base/util/env.js';
import * as path from 'path';
import * as fs from 'fs';
import type { HookRuntime } from '../../base/session/capture-contract.js';
import { bookTokenUse } from '../../api/ledger-db.js';
import { sessionPilotArm } from '../../api/pilot-arm.js';
import { cliFolder, cliLedgerReach, cliSyncOptions } from './api-context.js';
import { folderIndex } from '../../api/embeddings.js';
import type { CaptureTarget } from '../capture/command.js';
import { hookPayloadSessionId, hookPayloadString, isSubagentPayload } from '../../base/util/hook-payload.js';
import { importAtSessionEnd } from '../../domain/agent-memories/sync.js';
import { currentMachine } from '../../infra/machine.js';
import { summaryLine } from '../../domain/agent-memories/report.js';
import { getHippoRoot, isInitialized, resolveGlobalRootDir } from '../../host/project-identity.js';
import { sanitizeLogMessage } from '../capture/compact.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import { type CliFlags, stringFlag } from './flag-values.js';

/**
 * Detached worker (internal `__session-end-worker`): counts re-reads, runs sleep, then capture; one stage failing does
 * not block the other.
 */
/**
 * A folder without its own store never sleeps at session end, so its project's agent notes go to the global store here.
 */
export async function logSessionEndImport(
  logFile: string | null,
  tenantId: string,
  transcriptPath: string | undefined,
): Promise<void> {
  try {
    const sync = cliSyncOptions(tenantId, currentMachine());
    const report = await importAtSessionEnd(process.cwd(), transcriptPath, sync);
    const line = summaryLine(report);
    if (line !== null) appendSessionEndCloseLog(logFile, line);
    for (const warning of report.warnings) appendSessionEndCloseLog(logFile, `agent memories: ${warning}`);
  } catch (err) {
    appendSessionEndCloseLog(logFile, `agent memory import failed: ${errorMessage(err)}`);
  }
}

/**
 * Best-effort log line for the handleSessionEndWorker snapshot-close step: handleSleep/runCapture restore their
 * console tee before this runs, so console.log would be lost under the worker's `stdio: 'ignore'`; write to the file
 * directly. */
export function appendSessionEndCloseLog(
  logFile: string | null,
  message: string,
  opts: { startFresh?: boolean } = {},
): void {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // sanitizeLogMessage: `message` interpolates the payload-controlled session_id, the same log-forgery guard
    // appendPreCompactLog applies.
    const write = opts.startFresh ? fs.writeFileSync : fs.appendFileSync;
    write(logFile, `[hippo] ${new Date().toISOString()} ${sanitizeLogMessage(message)}\n`, 'utf8');
  } catch (err) {
    // Best-effort only: a log-write failure must never fail the hook.
    log.debug(`session-end log not written: ${errorMessage(err)}`, errorFields(err));
  }
}

/**
 * A session-end step that failed: one warn line, and the same text in the session log, the only place a detached
 * worker's output survives.
 */
export function reportSessionEndFailure<E>(logFile: string | null, step: string, err: E): void {
  const line = `${step} failed: ${errorMessage(err)}`;
  log.warn(line, errorFields(err));
  appendSessionEndCloseLog(logFile, line);
}

// Claude Code exports its own session var, not ours; without the fallback agent-run recalls trace with no session.
export function hostSessionId(): string | undefined {
  return envHippoSessionId() ?? envClaudeCodeSessionId();
}

/**
 * Compaction drops the pinned blocks the per-prompt hook injected, so record a `reset` for the payload's session and
 * the next prompt injects again.
 * `requiredSource` limits it to payloads with that `source`; best-effort and silent on a malformed payload. */
export async function resetHookInjection(
  hippoRoot: string,
  tenantId: string,
  stdinText: string | undefined,
  requiredSource: string | null,
): Promise<void> {
  const sessionId = hookPayloadSessionId(stdinText, requiredSource);
  // A sub-agent's compaction leaves its parent's context, and the blocks in it, as they were.
  if (sessionId === null || isSubagentPayload(stdinText)) return;
  await bookTokenUse(
    {
      tenantId,
      sessionId,
      surface: 'hook',
      event: 'reset',
      items: 0,
      tokens: 0,
    },
    cliLedgerReach(hippoRoot),
  );
}

/**
 * Store a hook writes to: the project store, else an existing global one, else the project path (skipped: hooks must
 * not create a store).
 * Pre-compact and compact-resume must agree, or a snapshot is looked for in the other store. */
export function hookStoreRoot(hippoRoot: string): string {
  if (isInitialized(hippoRoot)) return hippoRoot;
  const globalRoot = resolveGlobalRootDir();
  return isInitialized(globalRoot) ? globalRoot : hippoRoot;
}

/**
 * `--runtime copilot`, or `--format copilot` on `hippo context`, marks a Copilot hook: the flag decides, never the
 * payload.
 */
export function hookRuntime(flags: CliFlags): HookRuntime {
  return stringFlag(flags, 'runtime') === 'copilot' || stringFlag(flags, 'format') === 'copilot'
    ? 'copilot'
    : 'claude-code';
}

/**
 * A Copilot hook's project root, from the payload's `cwd`, since VS Code runs user-level hooks in the home folder;
 * other runtimes keep `hippoRoot`.
 */
export function payloadCwdRoot(hippoRoot: string, stdinText: string | undefined, runtime: HookRuntime): string {
  const cwd = runtime === 'copilot' ? hookPayloadString(stdinText, 'cwd') : null;
  if (cwd === null || cwd.trim() === '') return hippoRoot;
  try {
    // Moving, not just re-rooting, keeps project identity, scope, handoff evidence and the session-end worker on that
    // folder too.
    process.chdir(cwd);
  } catch (err) {
    log.warn(
      `hippo: payload cwd ${cwd} is not usable, so the hook stays in ${process.cwd()}: ${errorMessage(err)}`,
      errorFields(err),
    );
    return hippoRoot;
  }
  return getHippoRoot(process.cwd());
}

/** Whether this session sits in the pilot's holdout arm; off at rate 0 and with no session id. */
export async function inPilotHoldout(
  hippoRoot: string,
  tenantId: string,
  sessionId: string | undefined,
  opts: { write: boolean },
): Promise<boolean> {
  const reach = cliLedgerReach(hippoRoot);
  return (await sessionPilotArm(tenantId, sessionId, opts.write, { reach })) === 'holdout';
}

/** What capture writes into for a store folder: its port, its config and the index that embeds the new rows. */
export function captureTarget(root: string): CaptureTarget {
  const folder = cliFolder(root);
  return { root, store: folder.store, config: folder.config, index: folderIndex(folder) };
}
