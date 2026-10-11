// What the hook commands share: session id, store choice, delivery recorder, session-end log and store-busy handling.

import { envClaudeCodeSessionId, envHippoSessionId } from '../util/env.js';
import * as path from 'path';
import * as fs from 'fs';
import type { HookRuntime } from '../core/capture-contract.js';
import { getHippoRoot, isInitialized } from '../store/open.js';
import { loadConfig } from '../core/config.js';
import { createDeliveryRecorder, type DeliveryEventType, type DeliveryRecorder } from '../store/delivery-recorder.js';
import { isSqliteBusy, noteStoreBusy, runWithRequestStores, HOOK_DB_WAIT_MS } from '../db/index.js';
import { bookTokenUse, ledgerRoot } from '../api/ledger-db.js';
import { sessionPilotArm } from '../api/pilot-arm.js';
import { hookPayloadSessionId, hookPayloadString, isSubagentPayload } from '../util/hook-payload.js';
import { blockHash } from '../util/token-text.js';
import { importAtSessionEnd, currentMachine } from '../agent-memories/sync.js';
import { summaryLine } from '../agent-memories/report.js';
import { isGlobalStoreRoot } from '../core/project-identity.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { sanitizeLogMessage } from '../capture/compact.js';
import { resolveTenantId } from '../store/tenant.js';
import { errorMessage, log } from '../util/log.js';
import type { CliFlags } from './flag-values.js';

/** Detached worker (internal `__session-end-worker`): counts re-reads, runs sleep, then capture; one stage failing does not block the other. */
/** A folder without its own store never sleeps at session end, so its project's agent notes go to the global store here. */
export function logSessionEndImport(logFile: string | null, transcriptPath: string | undefined): void {
  try {
    const report = importAtSessionEnd(process.cwd(), transcriptPath, { machine: currentMachine() });
    const line = summaryLine(report);
    if (line !== null) appendSessionEndCloseLog(logFile, line);
    for (const warning of report.warnings) appendSessionEndCloseLog(logFile, `agent memories: ${warning}`);
  } catch (err) {
    appendSessionEndCloseLog(logFile, `agent memory import failed: ${errorMessage(err)}`);
  }
}

/** Best-effort log line for the cmdSessionEndWorker snapshot-close step: cmdSleep/cmdCapture restore their console tee before this runs,
 * so console.log would be lost under the worker's `stdio: 'ignore'`; write to the file directly. */
export function appendSessionEndCloseLog(logFile: string | null, message: string, opts: { startFresh?: boolean } = {}): void {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // sanitizeLogMessage: `message` interpolates the payload-controlled
    // session_id — same log-forgery guard appendPreCompactLog applies.
    const write = opts.startFresh ? fs.writeFileSync : fs.appendFileSync;
    write(logFile, `[hippo] ${new Date().toISOString()} ${sanitizeLogMessage(message)}\n`, 'utf8');
  } catch (err) {
    // Best-effort only: a log-write failure must never fail the hook.
    log.debug(`session-end log not written: ${errorMessage(err)}`);
  }
}

/** A session-end step that failed: one warn line, and the same text in the session log, the only place a detached worker's output survives. */
export function reportSessionEndFailure<E>(logFile: string | null, step: string, err: E): void {
  const line = `${step} failed: ${errorMessage(err)}`;
  log.warn(line);
  appendSessionEndCloseLog(logFile, line);
}

// Claude Code exports its own session var, not ours; without the fallback agent-run recalls trace with no session.
export function hostSessionId(): string | undefined {
  return envHippoSessionId() ?? envClaudeCodeSessionId();
}

/** Compaction drops the pinned blocks the per-prompt hook injected, so record a `reset` for the payload's session and the next prompt injects again.
 * `requiredSource` limits it to payloads with that `source`; best-effort and silent on a malformed payload. */
export function resetHookInjection(hippoRoot: string, stdinText: string | undefined, requiredSource: string | null): void {
  const sessionId = hookPayloadSessionId(stdinText, requiredSource);
  // A sub-agent's compaction leaves its parent's context, and the blocks in it, as they were.
  if (sessionId === null || isSubagentPayload(stdinText)) return;
  bookTokenUse(hippoRoot, {
    tenantId: resolveTenantId({}), sessionId, surface: 'hook', event: 'reset', items: 0, tokens: 0,
  });
}

/** Store a hook writes to: the project store, else an existing global one, else the project path (skipped: hooks must not create a store).
 * Pre-compact and compact-resume must agree, or a snapshot is looked for in the other store. */
export function hookStoreRoot(hippoRoot: string): string {
  if (isInitialized(hippoRoot)) return hippoRoot;
  const globalRoot = getGlobalRoot();
  return isInitialized(globalRoot) ? globalRoot : hippoRoot;
}

/** `--runtime copilot`, or `--format copilot` on `hippo context`, marks a Copilot hook: the flag decides, never the payload. */
export function hookRuntime(flags: CliFlags): HookRuntime {
  return flags['runtime'] === 'copilot' || flags['format'] === 'copilot' ? 'copilot' : 'claude-code';
}

/** A delivery recorder when the ledger store enables one, else null; never throws. */
export function startDeliveryRecorder(
  hippoRoot: string,
  stdinText: string | undefined,
  runtime: HookRuntime,
  eventType?: DeliveryEventType,
): DeliveryRecorder | null {
  try {
    // The same store the token ledger writes to, so its config governs both.
    const root = ledgerRoot(hippoRoot);
    if (root === null || !loadConfig(root).deliveryLedger.enabled) return null;
    return createDeliveryRecorder({
      root,
      storeHash: blockHash(path.resolve(root)),
      writeStore: isGlobalStoreRoot(root) ? 'global' : 'local',
      tenantId: resolveTenantId({}),
      stdinText,
      envSessionId: hostSessionId(),
      runtime: runtime === 'copilot' ? 'copilot' : undefined,
      eventType,
    });
  } catch (error) {
    log.warn(`delivery ledger skipped: ${errorMessage(error)}`);
    return null;
  }
}

/** A Copilot hook's project root, from the payload's `cwd`, since VS Code runs user-level hooks in the home folder; other runtimes keep `hippoRoot`. */
export function payloadCwdRoot(hippoRoot: string, stdinText: string | undefined, runtime: HookRuntime): string {
  const cwd = runtime === 'copilot' ? hookPayloadString(stdinText, 'cwd') : null;
  if (cwd === null || cwd.trim() === '') return hippoRoot;
  try {
    // Moving, not just re-rooting, keeps project identity, scope, handoff evidence and the session-end worker on that folder too.
    process.chdir(cwd);
  } catch (err) {
    log.warn(`hippo: payload cwd ${cwd} is not usable, so the hook stays in ${process.cwd()}: ${errorMessage(err)}`);
    return hippoRoot;
  }
  return getHippoRoot(process.cwd());
}

/** Hook commands share one handle per store and wait at most HOOK_DB_WAIT_MS for a lock; a store still busy after that skips the hook's
 * work with one warning, exit 0. */
export async function runHookWithStores<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await runWithRequestStores(fn, { busyWaitMs: HOOK_DB_WAIT_MS, failFastWhenBusy: true });
  } catch (error) {
    if (!isSqliteBusy(error)) throw error;
    noteStoreBusy('hook skipped');
    return undefined;
  }
}

/** Whether this session sits in the pilot's holdout arm; off at rate 0 and with no session id. */
export function inPilotHoldout(hippoRoot: string, tenantId: string, sessionId: string | undefined, write: boolean): boolean {
  return sessionPilotArm(hippoRoot, tenantId, sessionId, write) === 'holdout';
}
