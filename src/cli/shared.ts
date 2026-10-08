// Helpers two or more CLI verbs use, split from cli.ts so a verb can move to its own file without importing cli.ts.
// This module must never import cli.ts.

import { envApiKey, envClaudeCodeSessionId, envHippoSessionId, envRequireServer } from '../env.js';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync, execSync } from 'child_process';
import { installJsonHooks, type InstallResult } from '../hooks/json-hooks.js';
import { CODEX_TRUST_LINE } from '../hooks/shared.js';
import { confidenceLabel } from '../memory.js';
import { TaskSnapshot, SessionEvent } from '../store/rows.js';
import { getHippoRoot, isInitialized } from '../store/open.js';
import type { HookRuntime } from '../capture-contract.js';
import type { SessionHandoff } from '../handoff.js';
import type { SearchResult } from '../search/types.js';
import { explainMatch } from '../search/explain.js';
import { isSharedStore, loadConfig, type HippoConfig } from '../config.js';
import { createDeliveryRecorder, type DeliveryEventType, type DeliveryRecorder } from '../delivery-recorder.js';
import { openHippoDb, closeHippoDb, isSqliteBusy, noteStoreBusy, runWithRequestStores, HOOK_DB_WAIT_MS } from '../db.js';
import { ledgerRoot, withLedgerDb } from '../ledger-db.js';
import { sessionPilotArm } from '../pilot-arm.js';
import { blockHash, hookPayloadSessionId, hookPayloadString, isSubagentPayload, recordTokenUse } from '../token-ledger.js';
import { importAtSessionEnd, currentMachine } from '../agent-memories/sync.js';
import { type ImportReport, summaryLine } from '../agent-memories/report.js';
import { type ChurnStaleResult, detectChurnStale } from '../invalidation.js';
import { isGlobalStoreRoot, resolveProjectIdentity } from '../project-identity.js';
import { getGlobalRoot, initGlobal } from '../shared.js';
import { DAILY_TASK_NAME, buildDailyRunnerCommand, buildSchtasksCreateArgs, buildWindowsTaskRun } from '../scheduler.js';
import { sanitizeLogMessage } from '../capture/compact.js';
import { type AuditOp, appendAuditEvent, reportAuditWriteFailure } from '../audit.js';
import * as client from '../client.js';
import { type ServerInfo, detectServer, removePidfileIfOwned } from '../server-detect.js';
import { resolveTenantId } from '../tenant.js';
import { type Context, adminActor, learn, CLI_LEARN } from '../api.js';
import type { RecallSearchOpts } from '../recall-pipeline.js';
import { snapshotText, sessionTrailText, handoffText } from '../context-render.js';
import { errorMessage, log } from '../log.js';
import { printError } from './output.js';

export function parseLimitFlag(value: string | boolean | string[] | undefined): number {
  if (!value) return Infinity;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : Infinity;
}

export function parseCountFlag(value: string | boolean | string[] | undefined): number {
  if (!value || value === true || Array.isArray(value)) return 0;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 0;
}

export function parseBudgetFlag(value: string | boolean | string[] | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  // A value-less flag and a junk value are different typos; the --hops guard already splits them.
  if (typeof value !== 'string') {
    printError('--budget requires an integer value (e.g. --budget 1500).');
    process.exit(1);
  }
  // Number(), like the --hops guard: parseInt('12abc') is 12, silently accepting what this message rejects.
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    printError(`Invalid --budget: "${value}". Must be a non-negative integer.`);
    process.exit(1);
  }
  return parsed;
}

/**
 * Emit an audit event against `hippoRoot`'s db. Opens its own short-lived
 * connection so callers don't have to thread a db handle. Swallows all errors
 * — audit must never crash a CLI command.
 */
export function emitCliAudit(
  hippoRoot: string,
  op: AuditOp,
  targetId?: string,
  metadata?: Record<string, unknown>,
): void {
  try {
    const db = openHippoDb(hippoRoot);
    try {
      appendAuditEvent(db, {
        tenantId: resolveTenantId({}),
        actor: 'cli',
        op,
        targetId,
        metadata,
      });
    } finally {
      closeHippoDb(db);
    }
  } catch (error) {
    // Best effort: the command already did its work.
    reportAuditWriteFailure(op, String(error), targetId);
  }
}

export function requireInit(hippoRoot: string): void {
  if (!isInitialized(hippoRoot)) {
    printError(`No hippo store at ${hippoRoot} (searched ${process.cwd()} and its parents up to your home directory). Run \`hippo init\` first.`);
    process.exit(1);
  }
}

/** Runs detectChurnStale against every store this repo's memories can live in. */
export function runChurnStaleForRepo(hippoRoot: string, dryRun: boolean): { root: string; result: ChurnStaleResult }[] {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
  const { name: projectName, legacyName } = resolveProjectIdentity(process.cwd());
  const globalRoot = getGlobalRoot();
  const roots = globalRoot !== hippoRoot && isInitialized(globalRoot) ? [hippoRoot, globalRoot] : [hippoRoot];
  const tenantId = resolveTenantId({});
  return roots.map((root) => {
    // One store failing must not abort sleep's later phases or skip the other store.
    try {
      return { root, result: detectChurnStale(root, repoRoot, { tenantId, projectName, legacyName, dryRun }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { root, result: { checked: 0, marked: 0, alreadyMarked: 0, skippedPinned: [], dryRun, preview: [], error: message } };
    }
  });
}

/**
 * When HIPPO_REQUIRE_SERVER is set, the CLI must not silently fall back to
 * direct DB mode — a missing server then masks a real misconfiguration (the
 * configured HIPPO_API_KEY is also silently discarded on fallback). Throws a
 * clear error then. It guards only the routed writes (remember, forget, archive,
 * promote); every other command opens the store directly, knob or not.
 */
function failIfServerRequired(reason: string): void {
  if (envRequireServer()) {
    throw new Error(
      `hippo: HIPPO_REQUIRE_SERVER is set but ${reason}. ` +
      `Start \`hippo serve\`, or unset HIPPO_REQUIRE_SERVER to allow direct-mode fallback.`,
    );
  }
}

/**
 * Run an HTTP-routed command if a `hippo serve` instance is detected for
 * `hippoRoot`. Returns:
 *   - true  if the HTTP path ran (success OR a structured server error that
 *           was already surfaced to stdout/stderr by `httpFn`),
 *   - false if no server was detected, or if the detected pidfile turned out
 *           to be stale (connection refused). On stale, the pidfile is removed
 *           if it still names that dead server (a newer one may have replaced
 *           it) and the caller should fall back to the direct path.
 *
 * Stale pidfiles must self-heal, not crash.
 * When HIPPO_REQUIRE_SERVER is set, both fallback paths throw instead of
 * returning false, so a missing server fails loudly rather than silently
 * degrading to direct mode.
 */
export async function runViaServerIfAvailable(
  hippoRoot: string,
  httpFn: (info: ServerInfo, apiKey: string | undefined) => Promise<void>,
): Promise<boolean> {
  const info = await detectServer(hippoRoot);
  if (!info) {
    failIfServerRequired('no running server was detected for this hippoRoot');
    return false;
  }
  const apiKey = envApiKey();
  try {
    await httpFn(info, apiKey);
    return true;
  } catch (err) {
    const failure = client.classifyTransportFailure(err);
    if (failure === 'never-sent') {
      failIfServerRequired('the server pidfile was stale (connection refused)');
      log.warn('stale server pidfile detected, falling back to direct mode');
      // Clear the pidfile only if it still names the dead server we just
      // probed — a newer server may have rewritten it (removePidfileIfOwned).
      removePidfileIfOwned(hippoRoot, { pid: info.pid, startedAt: info.started_at });
      return false;
    }
    if (failure === 'delivery-unknown') {
      // Every caller of this helper is a non-idempotent write, so replaying on
      // the direct path would store a row the server may already have committed.
      // Leave the pidfile alone: the next command's connect-phase failure heals it.
      printError(
        `hippo: the connection to ${info.url} dropped or timed out mid-request, so the write may already have been applied. Not retrying locally. Check with \`hippo recall\` before running this again.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

export function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

// What `hippo recall` prints for one result; the budget prices this same text.
export function recallEntryText(r: SearchResult, query: string, showWhy: boolean, isGlobal: boolean): string {
  const e = r.entry;
  const label = confidenceLabel(e);
  const confLabel = label.warn ? `[${label.text}] ⚠️` : `[${label.text}]`;
  const bars = Math.round(e.strength * 10);
  const graphMark = r.graphVia ? ` [graph: ${r.graphVia.hops}hop ${r.graphVia.relType}]` : '';
  const lines = [
    `--- ${e.id} [${e.layer}] ${confLabel}${isGlobal ? ' [global]' : ''}${e.superseded_by ? ' [superseded]' : ''}${graphMark} score=${fmt(r.score, 3)} strength=${fmt(e.strength)}`,
    `    [${'█'.repeat(bars)}${'░'.repeat(10 - bars)}] tags: ${e.tags.join(', ') || 'none'} | retrieved: ${e.retrieval_count}x`,
  ];
  if (showWhy) {
    const explanation = explainMatch(query, r);
    lines.push(`    source:${isGlobal ? ' [global]' : ' [local]'} | layer: [${e.layer}] | confidence: [${label.text}]`, `    reason: ${explanation.reason}`);
    const env = explanation.envelope;
    if (env) {
      lines.push(`    kind: ${env.kind}`);
      if (env.scope) lines.push(`    scope: ${env.scope}`);
      if (env.owner) lines.push(`    owner: ${env.owner}`);
      if (env.artifact_ref) lines.push(`    artifact_ref: ${env.artifact_ref}`);
      if (env.session_id) lines.push(`    session_id: ${env.session_id}`);
      lines.push(`    confidence: ${env.confidence}`);
    }
    // The recall trace, e.g. "ranking: base 0.420 -> interference x0.30 -> 0.126 -> goal-boost x1.50 -> 0.189".
    if (r.rerankTrace && r.rerankTrace.length > 0) {
      const parts = [`base ${fmt(r.rerankTrace[0].scoreBefore, 3)}`];
      for (const step of r.rerankTrace) {
        parts.push(`${step.stage}${step.multiplier !== undefined ? ` x${fmt(step.multiplier, 2)}` : ''}`, fmt(step.scoreAfter, 3));
      }
      lines.push(`    ranking: ${parts.join(' -> ')}`);
    }
  }
  lines.push('', e.content, '');
  return lines.join('\n');
}

export function recallHeading(entries: number, tokens: number, query: string): string {
  return `Found ${entries} memories (${tokens} tokens) for: "${query}"\n`;
}

/** One line when an agent memory import moved anything; its warnings go to stderr. */
export function printAgentImport(report: ImportReport, indent = '   '): void {
  const line = summaryLine(report);
  if (line !== null) console.log(`${indent}${line}`);
  for (const warning of report.warnings) printError(`hippo: agent memories: ${warning}`);
}

/** True, after one line, on a shared store: this account's commits and agent notes are not its members' memories. */
export function skipLearnOnSharedStore(hippoRoot: string): boolean {
  if (!isSharedStore(hippoRoot)) return false;
  console.log("Shared store: skipped learning from this account's git commits and coding agents' own memories.");
  return true;
}

/** Adds hippo's two Codex hooks and says what changed; each install ends on the trust reminder, since Codex skips an untrusted hook. */
export function installCodexMemoryHooks(indent: string): void {
  const result = installJsonHooks('codex');
  if (result.invalidJson) {
    console.log(`${indent}WARNING: ${result.settingsPath} is not a hooks file hippo can merge into; fix it, then run \`hippo hook install codex\`.`);
    return;
  }
  const added = [
    result.installedUserPromptSubmit ? 'UserPromptSubmit' : '',
    result.installedCompactResume ? 'SessionStart(compact)' : '',
  ].filter(Boolean);
  console.log(added.length > 0
    ? `${indent}Installed hippo's Codex memory hooks (${added.join(', ')}) in ${result.settingsPath}`
    : `${indent}hippo's Codex memory hooks already in ${result.settingsPath}`);
  console.log(`${indent}${CODEX_TRUST_LINE}`);
}

/** The one line init, hook install, hook uninstall and setup print when Claude Code's settings.json is not JSON hippo can edit and so was left unchanged; true when it printed. */
export function warnClaudeSettingsUnusable(result: Pick<InstallResult, 'settingsPath' | 'invalidJson'>, indent: string, action: 'install' | 'uninstall' = 'install'): boolean {
  if (!result.invalidJson) return false;
  console.log(`${indent}WARNING: ${result.settingsPath} is not a JSON object hippo can merge into, so it was left unchanged; fix it, then run \`hippo hook ${action} claude-code\`.`);
  return true;
}

/**
 * Set up a machine-level daily runner that sweeps all registered Hippo
 * workspaces.
 * Linux/macOS: writes to user crontab.
 * Windows: creates a scheduled task.
 * Skips if already installed.
 */
export function setupDailySchedule(globalRoot: string): void {
  const runnerDir = path.resolve(globalRoot);
  // Reject paths with characters that could break shell/crontab quoting
  // (backslash is normal on Windows, only dangerous in Unix shell/crontab)
  const unsafeChars = process.platform === 'win32' ? /["`$%\n\r]/ : /["`$\n\r\\]/;
  if (unsafeChars.test(runnerDir)) {
    console.log(`   Skipping schedule: runner path contains unsafe characters.`);
    return;
  }
  const isWindows = process.platform === 'win32';
  const taskName = DAILY_TASK_NAME;
  const cmd = buildDailyRunnerCommand(runnerDir);

  if (isWindows) {
    // Check if task already exists
    try {
      const existing = execSync(`schtasks /query /tn "${taskName}" 2>nul`, { encoding: 'utf-8', windowsHide: true });
      if (existing.includes(taskName)) {
        return; // already scheduled
      }
    } catch {
      // Task doesn't exist, create it
    }

    try {
      execFileSync('schtasks', buildSchtasksCreateArgs(taskName, cmd), { stdio: 'pipe', windowsHide: true });
      console.log(`   Scheduled machine-level daily runner (6:15am) via Task Scheduler: ${taskName}`);
    } catch {
      // No admin rights or schtasks unavailable, fall back to printing instructions
      console.log(`   To schedule the machine-level daily runner, run:`);
      console.log(`   schtasks /create /tn "${taskName}" /tr "${buildWindowsTaskRun(cmd).replace(/"/g, '\\"')}" /sc daily /st 06:15`);
    }
  } else {
    // Unix: check crontab for existing entry
    const marker = `# hippo:${taskName}`;
    try {
      const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8', windowsHide: true });
      if (existing.includes(marker)) {
        return; // already scheduled
      }

      const cronLine = `15 6 * * * ${cmd} ${marker}`;
      const newCrontab = existing.trimEnd() + '\n' + cronLine + '\n';
      execSync('crontab -', { input: newCrontab, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      console.log(`   Scheduled machine-level daily runner (6:15am) via crontab`);
    } catch {
      // No crontab or no permission: print the line for the user to add by hand.
      const cronLine = `15 6 * * * ${cmd}`;
      console.log(`   To schedule the machine-level daily runner, add to crontab (crontab -e):`);
      console.log(`   ${cronLine}`);
    }
  }
}

export type CliFlags = Record<string, string | boolean | string[]>;

/** What the command table hands each verb's run(). */
export interface CommandContext {
  readonly hippoRoot: string;
  readonly args: string[];
  readonly flags: CliFlags;
}

export type EngineFlags = Pick<RecallSearchOpts, 'usePhysics' | 'physicsConfig' | 'mmr' | 'mmrLambda' | 'localBump'>;

export function parseAsOfFlag(flags: CliFlags): string | undefined {
  const asOf = typeof flags['as-of'] === 'string' ? flags['as-of'] : undefined;
  if (asOf !== undefined && Number.isNaN(new Date(asOf).getTime())) {
    printError(`Error: --as-of value "${asOf}" is not a valid ISO date (e.g. 2026-04-22 or 2026-04-22T12:00:00Z).`);
    process.exit(1);
  }
  return asOf;
}

/** --physics forces physics, --classic forces BM25+cosine, else physics unless the config turns it off. */
export function engineFlags(flags: CliFlags, config: HippoConfig): EngineFlags {
  return {
    usePhysics: Boolean(flags['physics']) || (!flags['classic'] && config.physics.enabled !== false),
    physicsConfig: config.physics,
    mmr: !flags['no-mmr'] && config.mmr.enabled,
    mmrLambda: flags['mmr-lambda'] !== undefined ? parseFloat(String(flags['mmr-lambda'])) : config.mmr.lambda,
    localBump: flags['equal-sources']
      ? 1.0
      : flags['local-bump'] !== undefined ? parseFloat(String(flags['local-bump'])) : config.search.localBump,
  };
}

/**
 * Detached worker that counts re-reads, runs sleep, then capture. Invoked via the internal
 * `__session-end-worker` subcommand (not user-facing). Failures in one stage
 * do not block the other.
 */
/** A folder without its own store never sleeps at session end, so its project's agent notes go to the global store here. */
export function logSessionEndImport(logFile: string | null, transcriptPath: string | undefined): void {
  try {
    const report = importAtSessionEnd(process.cwd(), transcriptPath, { machine: currentMachine() });
    const line = summaryLine(report);
    if (line !== null) appendSessionEndCloseLog(logFile, line);
    for (const warning of report.warnings) appendSessionEndCloseLog(logFile, `agent memories: ${warning}`);
  } catch (err) {
    appendSessionEndCloseLog(logFile, `agent memory import failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Best-effort log line for the snapshot-close step in
 * `cmdSessionEndWorker`. `cmdSleep`/`cmdCapture` each tee console output to
 * `logFile` only for their own duration (the tee is restored before this
 * runs), so a plain `console.log` here would be silently discarded under
 * the detached worker's `stdio: 'ignore'` — write straight to the file
 * instead, matching capture.ts's `appendPreCompactLog` convention.
 */
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

export function printActiveTaskSnapshot(snapshot: TaskSnapshot): void {
  console.log(snapshotText(snapshot));
}

export function printSessionEvents(events: SessionEvent[]): void {
  console.log(events.length === 0 ? 'No session events found.' : sessionTrailText(events));
}

export function printHandoff(handoff: SessionHandoff): void {
  console.log(handoffText(handoff));
}

// parseArgs turns a value-less flag into `true`; refuse rather than silently
// stringifying it (String(true) === 'true'), mirroring cmdHandoff's guard.
export function cardStringFlag(flags: Record<string, string | boolean | string[]>, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (v === true || v === false || Array.isArray(v)) { printError(`--${key} requires a value`); process.exit(1); }
  return v.trim();
}

// Claude Code exports its own session var, not ours; without the fallback agent-run recalls trace with no session.
export function hostSessionId(): string | undefined {
  return envHippoSessionId() ?? envClaudeCodeSessionId();
}

/**
 * Compaction drops the pinned blocks the per-prompt hook injected
 * earlier, so record a `reset` for the payload's session and the next prompt
 * injects again even if nothing changed. `requiredSource` limits it to hook
 * payloads with that `source` (SessionStart fires for other reasons too).
 * Best-effort and silent: a malformed payload records nothing.
 */
export function resetHookInjection(hippoRoot: string, stdinText: string | undefined, requiredSource: string | null): void {
  const sessionId = hookPayloadSessionId(stdinText, requiredSource);
  // A sub-agent's compaction leaves its parent's context, and the blocks in it, as they were.
  if (sessionId === null || isSubagentPayload(stdinText)) return;
  withLedgerDb(hippoRoot, (db) => recordTokenUse(db, {
    tenantId: resolveTenantId({}), sessionId, surface: 'hook', event: 'reset', items: 0, tokens: 0,
  }));
}

/**
 * Run `fn` with console.log captured; returns the captured lines joined by
 * newlines (what the same calls would have printed, minus the final newline).
 */
export function captureConsole(fn: () => void): string {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.log = realLog;
  }
  return lines.join('\n');
}

/**
 * The store a Claude Code hook writes to: the project store when there is
 * one, else an existing global store, else the project path (which the hook
 * then skips, since hooks fire in every directory and must not create one).
 * Pre-compact and compact-resume must agree, or a snapshot saved to one store
 * is looked for in the other.
 */
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
    // The same store withLedgerDb writes the token ledger to, so its config governs both.
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
    // The hook's one-line stderr contract pins this exact text, so it bypasses the leveled logger.
    printError(`[hippo] delivery ledger skipped:${error instanceof Error ? error.message : String(error)}`);
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

export function learnFromRepo(
  hippoRoot: string,
  repoPath: string,
  days: number,
  label?: string
): { added: number; skipped: number; lowInfo: number } {
  const prefix = label ? `[${label}] ` : '';
  const ctx: Context = { hippoRoot, tenantId: resolveTenantId({}), actor: adminActor('cli') };
  const result = learn(ctx, { repoPath, days, profile: CLI_LEARN });
  if (result.status === 'not-a-repo') {
    console.log(`${prefix}No git history found (or not a git repository).`);
    return { added: 0, skipped: 0, lowInfo: 0 };
  }
  if (result.status !== 'scanned') {
    console.log(`${prefix}No fix/revert/bug commits found in the specified period.`);
    return { added: 0, skipped: 0, lowInfo: 0 };
  }
  const { added, skipped, rejected, lowInfo } = result;
  for (const { from, count } of result.invalidations) {
    console.log(`${prefix}   Invalidated ${count} memories referencing "${from}"`);
  }
  console.log(
    `${prefix}${added} new lessons added, ${skipped} duplicates skipped` +
      (rejected > 0 ? `, ${rejected} rejected value(s) skipped` : '') +
      (lowInfo > 0 ? `, ${lowInfo} low-information subject(s) dropped` : '') +
      '.',
  );
  return { added, skipped, lowInfo };
}

export function resolveAuthRoot(hippoRoot: string, flags: Record<string, string | boolean | string[]>): string {
  if (flags['global']) {
    initGlobal();
    return getGlobalRoot();
  }
  requireInit(hippoRoot);
  return hippoRoot;
}

/** Hook commands share one handle per store and wait at most HOOK_DB_WAIT_MS for a lock; a store still busy after that skips the hook's work with one warning, exit 0. */
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
