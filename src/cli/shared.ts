// Store and server helpers the CLI verbs share: audit events, init checks, server routing, git learning and the auth root.
// This module must never import cli.ts.

import { envApiKey, envRequireServer } from '../util/env.js';
import { execFileSync } from 'child_process';
import { isSharedStore } from '../core/config.js';
import { isInitialized } from '../store/open.js';
import { type ChurnStaleResult, detectChurnStale } from '../learn/invalidation.js';
import { resolveProjectIdentity } from '../core/project-identity.js';
import { getGlobalRoot, initGlobal } from '../sharing/shared.js';
import { type AuditOp, reportAuditWriteFailure } from '../store/audit.js';
import { sqliteSyncStore } from '../store/sqlite/store.js';
import * as client from './client.js';
import { type ServerInfo, detectServer, removePidfileIfOwned } from '../server/server-detect.js';
import { resolveTenantId } from '../store/tenant.js';
import { type Context, adminActor, learn, CLI_LEARN } from '../api/index.js';
import { errorMessage, log } from '../util/log.js';
import { printError } from './output.js';
import type { CliFlags } from './flag-values.js';

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
    sqliteSyncStore(hippoRoot).appendAuditEvents([{
      tenantId: resolveTenantId({}),
      actor: 'cli',
      op,
      targetId,
      metadata,
    }]);
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
      const message = errorMessage(err);
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

/** True, after one line, on a shared store: this account's commits and agent notes are not its members' memories. */
export function skipLearnOnSharedStore(hippoRoot: string): boolean {
  if (!isSharedStore(hippoRoot)) return false;
  console.log("Shared store: skipped learning from this account's git commits and coding agents' own memories.");
  return true;
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

export function resolveAuthRoot(hippoRoot: string, flags: CliFlags): string {
  if (flags['global']) {
    initGlobal();
    return getGlobalRoot();
  }
  requireInit(hippoRoot);
  return hippoRoot;
}
