// What the hook commands share: session id, store choice, delivery recorder, session-end log and
// store-busy handling.

import { envClaudeCodeSessionId, envHippoSessionId } from '../../base/util/env.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { HookRuntime } from '../../base/session/capture-contract.js';
import { bookTokenUse } from '../../api/ledger-db.js';
import { sessionPilotArm } from '../../api/pilot-arm.js';
import { cliInfra, type CliCommand, type CliScope } from './api-context.js';
import { detachedEmbedder } from '../../api/embeddings.js';
import type { CaptureTarget } from '../capture/command.js';
import {
  hookPayloadSessionId,
  hookPayloadString,
  isSubagentPayload,
} from '../../base/util/hook-payload.js';
import { importAtSessionEnd } from '../../api/agent-memories.js';
import type { HeldLog } from '../../api/session-end.js';
import { currentMachine } from '../../infra/machine.js';
import { summaryLine } from '../../base/memory/agent-memory-report.js';
import { getHippoRoot, isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { sanitizeLogMessage } from '../capture/compact.js';
import {
  errorMessage,
  log,
  errorFields,
  formatFields,
  type LogFields,
} from '../../base/util/log.js';
import { type CliFlags, stringFlag } from './flag-values.js';
import { PRIVATE_DIR } from '../../host/private-dir.js';

/**
 * A folder without its own store never sleeps at session end, so its project's agent notes go to
 * the global store here.
 */
export async function logSessionEndImport(
  cli: CliCommand,
  logFile: string | null,
  tenantId: string,
  transcriptPath: string | undefined,
): Promise<void> {
  try {
    const sync = cli.syncOptions(tenantId, currentMachine());
    const report = await importAtSessionEnd(process.cwd(), transcriptPath, sync);
    const line = summaryLine(report);
    if (line !== null) appendSessionEndCloseLog(logFile, line);
    for (const warning of report.warnings) {
      appendSessionEndCloseLog(logFile, `agent memories: ${warning}`);
    }
  } catch (err) {
    appendSessionEndCloseLog(logFile, `agent memory import failed: ${errorMessage(err)}`, {
      fields: errorFields(err),
    });
  }
}

/**
 * Best-effort log line for the handleSessionEndWorker snapshot-close step: sleepStore/runCapture
 * restore their console tee before this runs, so console.log would be lost under the worker's
 * `stdio: 'ignore'`; write to the file directly. */
export function appendSessionEndCloseLog(
  logFile: string | null,
  message: string,
  opts: { startFresh?: boolean; fields?: LogFields } = {},
): void {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), PRIVATE_DIR);
    // sanitizeLogMessage: `message` interpolates the payload-controlled session_id, the same
    // log-forgery guard appendPreCompactLog applies.
    const write = opts.startFresh ? fs.writeFileSync : fs.appendFileSync;
    const text = sanitizeLogMessage(`${message}${formatFields(opts.fields)}`);
    write(logFile, `[hippo] ${new Date().toISOString()} ${text}\n`, 'utf8');
  } catch (err) {
    // A log-write failure must never fail the hook, but a log that never fills is told.
    log.warn(`session-end log not written: ${errorMessage(err)}`, errorFields(err));
  }
}

/** Runs `run` with the held lines written on exit too, as sleep may end the process before the
 * run writes them. */
export async function flushingOnExit(held: HeldLog, run: () => Promise<void>): Promise<void> {
  process.once('exit', held.flush);
  try {
    await run();
  } finally {
    process.off('exit', held.flush);
  }
}

/**
 * A session-end step that failed: one warn line, and the same text in the session log, the only
 * place a detached worker's output survives.
 */
export function reportSessionEndFailure<E>(logFile: string | null, step: string, err: E): void {
  const line = `${step} failed: ${errorMessage(err)}`;
  log.warn(line, errorFields(err));
  appendSessionEndCloseLog(logFile, line, { fields: errorFields(err) });
}

// Claude Code exports its own session var, not ours; without the fallback agent-run recalls trace
// with no session.
export function hostSessionId(): string | undefined {
  return envHippoSessionId() ?? envClaudeCodeSessionId();
}

/**
 * Compaction drops the pinned blocks the per-prompt hook injected, so record a `reset` for the
 * payload's session and the next prompt injects again. `requiredSource` limits it to payloads
 * with that `source`; best-effort and silent on a malformed payload. */
export async function resetHookInjection(
  { cli, hippoRoot, tenantId }: CliScope,
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
    cli.ledgerReach(hippoRoot),
  );
}

/**
 * Store a hook writes to: the project store, else an existing global one, else the project path
 * (skipped: hooks must not create a store). Pre-compact and compact-resume must agree, or a
 * snapshot is looked for in the other store. */
export function hookStoreRoot(hippoRoot: string): string {
  if (isInitialized(hippoRoot)) return hippoRoot;
  const globalRoot = hippoHomeDir();
  return isInitialized(globalRoot) ? globalRoot : hippoRoot;
}

/**
 * `--runtime copilot`, or `--format copilot` on `hippo context`, marks a Copilot hook: the flag
 * decides, never the payload.
 */
export function hookRuntime(flags: CliFlags): HookRuntime {
  return stringFlag(flags, 'runtime') === 'copilot' || stringFlag(flags, 'format') === 'copilot'
    ? 'copilot'
    : 'claude-code';
}

/**
 * A Copilot hook's project root, from the payload's `cwd`, since VS Code runs user-level hooks in
 * the home folder; other runtimes keep `hippoRoot`.
 */
export function payloadCwdRoot(
  hippoRoot: string,
  stdinText: string | undefined,
  runtime: HookRuntime,
): string {
  const cwd = runtime === 'copilot' ? hookPayloadString(stdinText, 'cwd') : null;
  if (cwd === null || cwd.trim() === '') return hippoRoot;
  try {
    // Moving, not just re-rooting, keeps project identity, scope, handoff evidence and the
    // session-end worker on that folder too.
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
  { cli, hippoRoot, tenantId }: CliScope,
  sessionId: string | undefined,
  opts: { write: boolean },
): Promise<boolean> {
  const reach = cli.ledgerReach(hippoRoot);
  return (await sessionPilotArm(tenantId, sessionId, opts.write, { reach })) === 'holdout';
}

/** What capture writes into for a store folder: its port, its config and what embeds the
 * new rows. */
export function captureTarget(cli: CliCommand, root: string): CaptureTarget {
  const folder = cli.folder(root);
  return {
    root,
    store: folder.store,
    config: folder.config,
    embed: detachedEmbedder(folder, cliInfra(), cli.detached),
  };
}
