// Store helpers the CLI verbs share: init checks, git learning and the auth root.
// This module must never import cli.ts.

import { isSharedStore } from '../../host/config-file.js';
import { markChurnStaleInReach, type ChurnStaleResult } from '../../api/sleep/churn.js';
import { isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { learn, CLI_LEARN } from '../../api/index.js';
import { processGit } from '../../infra/git-runner.js';
import { cliApiContext, cliInitGlobal } from './api-context.js';
import { fail } from './exit.js';
import { type CliFlags, boolFlag } from './flag-values.js';

export function requireInit(hippoRoot: string): void {
  if (!isInitialized(hippoRoot)) {
    fail(
      `No hippo store at ${hippoRoot} (searched ${process.cwd()} and its parents up to your home directory). Run ` +
        `\`hippo init\` first.`,
    );
  }
}

/** Runs churn staleness for the repo this process runs in, against every store its memories can
 * live in. */
export async function runChurnStaleForRepo(
  hippoRoot: string,
  tenantId: string,
  dryRun: boolean,
): Promise<{ root: string; result: ChurnStaleResult }[]> {
  return markChurnStaleInReach(cliApiContext(hippoRoot, tenantId), {
    root: hippoRoot,
    repoDir: process.cwd(),
    dryRun,
  });
}

/** True, after one line, on a shared store: this account's commits and agent notes are not its
 * members' memories. */
export function skipLearnOnSharedStore(hippoRoot: string): boolean {
  if (!isSharedStore(hippoRoot)) return false;
  console.log(
    "Shared store: skipped learning from this account's git commits and coding agents' own memories.",
  );
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
