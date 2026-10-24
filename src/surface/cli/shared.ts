// Store and server helpers the CLI verbs share: init checks, server routing, git learning and the auth root.
// This module must never import cli.ts.

import { envApiKey, envRequireServer } from '../../base/util/env.js';
import { isSharedStore } from '../../host/config-file.js';
import { markChurnStale, type ChurnStaleResult } from '../../api/sleep/churn.js';
import { isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import * as client from './client.js';
import { type ServerInfo, detectServer, removePidfileIfOwned } from '../server/server-detect.js';
import { learn, CLI_LEARN } from '../../api/index.js';
import { processGit } from '../../infra/git-runner.js';
import { cliApiContext, cliInfra, cliInitGlobal, cliStore } from './api-context.js';
import { log, errorFields } from '../../base/util/log.js';
import { fail } from './exit.js';
import { printError } from './output.js';
import { type CliFlags, boolFlag } from './flag-values.js';

export function requireInit(hippoRoot: string): void {
  if (!isInitialized(hippoRoot)) {
    fail(
      `No hippo store at ${hippoRoot} (searched ${process.cwd()} and its parents up to your home directory). Run ` +
        `\`hippo init\` first.`,
    );
  }
}

/** Runs churn staleness for the repo this process runs in, against every store its memories can live in. */
export async function runChurnStaleForRepo(
  hippoRoot: string,
  tenantId: string,
  dryRun: boolean,
): Promise<{ root: string; result: ChurnStaleResult }[]> {
  const globalRoot = hippoHomeDir();
  const roots = globalRoot !== hippoRoot && isInitialized(globalRoot) ? [hippoRoot, globalRoot] : [hippoRoot];
  const stores = roots.map((root) => ({ root, store: cliStore(root) }));
  return markChurnStale({ tenantId, infra: cliInfra() }, stores, { repoDir: process.cwd(), dryRun });
}

/**
 * With HIPPO_REQUIRE_SERVER set, throw rather than fall back to direct DB mode, which would mask a misconfiguration and
 * discard HIPPO_API_KEY.
 * Guards only the routed writes (remember, forget, archive, promote). */
function failIfServerRequired(reason: string): void {
  if (envRequireServer()) {
    throw new Error(
      `hippo: HIPPO_REQUIRE_SERVER is set but ${reason}. ` +
        `Start \`hippo serve\`, or unset HIPPO_REQUIRE_SERVER to allow direct-mode fallback.`,
    );
  }
}

/**
 * Run an HTTP-routed command if a `hippo serve` is detected: true if it ran, false on no server or a stale pidfile
 * (removed if it names the dead server).
 * With HIPPO_REQUIRE_SERVER set both fallbacks throw; a stale pidfile must self-heal, not crash. */
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
    const failure = err instanceof Error ? client.classifyTransportFailure(err) : 'none';
    if (failure === 'never-sent') {
      failIfServerRequired('the server pidfile was stale (connection refused)');
      log.warn('stale server pidfile detected, falling back to direct mode', errorFields(err));
      // Clear the pidfile only if it still names the dead server we just probed; a newer server may have rewritten it
      // (removePidfileIfOwned).
      removePidfileIfOwned(hippoRoot, { pid: info.pid, startedAt: info.started_at });
      return false;
    }
    if (failure === 'delivery-unknown') {
      // Every caller is a non-idempotent write, so replaying on the direct path would store a row the server may
      // already have committed; leave the pidfile alone: the next command's connect-phase failure heals it.
      printError(
        `hippo: the connection to ${info.url} dropped or timed out mid-request, so the write may already have been ` +
          `applied. ` +
          'Not retrying locally. Check with `hippo recall` before running this again.',
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

interface LearnFromRepoResult {
  added: number;
  skipped: number;
  lowInfo: number;
}

export async function learnFromRepo(
  hippoRoot: string,
  tenantId: string,
  repoPath: string,
  days: number,
  label?: string,
): Promise<LearnFromRepoResult> {
  const prefix = label ? `[${label}] ` : '';
  const result = await learn(cliApiContext(hippoRoot, tenantId), {
    repoPath,
    days,
    profile: CLI_LEARN,
    git: processGit,
  });
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
  if (boolFlag(flags, 'global')) {
    cliInitGlobal();
    return hippoHomeDir();
  }
  requireInit(hippoRoot);
  return hippoRoot;
}
