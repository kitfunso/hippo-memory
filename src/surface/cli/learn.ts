// `hippo watch` and `hippo learn`: take lessons from a watched command and from git history.

import * as path from 'node:path';
import { isInitialized } from '../../host/project-identity.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { DEFAULT_LEARN_DAYS } from '../../base/util/limits.js';
import { runWatched } from './run-watched.js';
import { rememberFailedCommand } from '../../api/memories/remember-local.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { requireInit, learnFromRepo, type LearnFromRepoOptions } from './shared.js';
import { type CommandContext, boolFlag, nonEmptyStringFlag, numberFlag } from './flag-values.js';
import { CliExit, fail } from './exit.js';

const STDERR_PREVIEW_CHARS = 80;

const WATCH_USAGE = 'Usage: hippo watch -- <command> [args...]';

/** The argv to run, which no shell parses. */
function watchedCommand(args: readonly string[]): string[] {
  if (args.length === 0) {
    fail(WATCH_USAGE);
  }
  // A quoted 1.x command line would now run as one program name, so it is refused rather than
  // guessed at.
  if (args.length === 1 && /\s/.test(args[0]!)) {
    fail(`hippo watch: "${args[0]}" is one argument with spaces. Use \`hippo watch -- cmd args\`.`);
  }
  return [...args];
}

export async function handleWatch({ hippoRoot, tenantId, args }: CommandContext): Promise<void> {
  const argv = watchedCommand(args);
  const command = argv.join(' ');
  const { exitCode, stderr } = await runWatched(argv);

  if (exitCode === 0) {
    // Success: no noise
    return;
  }

  if (!isInitialized(hippoRoot)) {
    printError('Command failed but .hippo not initialized. Run `hippo init` to enable auto-learn.');
    throw new CliExit(exitCode);
  }

  // A rejection-guard refusal of a failed command's output must not crash the watcher: skip with
  // the message below and still exit with the wrapped command's real exit code.
  try {
    await rememberFailedCommand(cliApiContext(hippoRoot, tenantId), { command, exitCode, stderr });

    const preview = stderr.trim().slice(0, STDERR_PREVIEW_CHARS);
    printError(`\nHippo learned from failure: "${preview}"`);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      printError(
        `\nHippo: this failure matches a rejected value (${err.reason ?? 'no reason given'}); not stored.`,
      );
    } else {
      throw err;
    }
  }

  throw new CliExit(exitCode);
}

export async function handleLearn({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  if (!boolFlag(flags, 'git')) {
    fail('Usage: hippo learn --git [--days <n>] [--repos <paths>]');
  }

  const days = numberFlag(flags, 'days') ?? DEFAULT_LEARN_DAYS;

  console.log(`Scanning git log for the last ${days} days...`);

  const reposFlag = nonEmptyStringFlag(flags, 'repos');
  if (reposFlag) {
    await learnFromRepos(reposFlag, { hippoRoot, tenantId, days });
  } else {
    const { added, skipped } = await learnFromRepo({
      hippoRoot,
      tenantId,
      repoPath: process.cwd(),
      days,
    });
    console.log(`Git learn complete: ${added} new lessons added, ${skipped} duplicates skipped.`);
  }
}

/** `--repos a,b`: learns each repo under its folder name, then prints the totals. */
async function learnFromRepos(
  reposFlag: string,
  base: Omit<LearnFromRepoOptions, 'repoPath' | 'label'>,
): Promise<void> {
  const repos = reposFlag
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  let totalAdded = 0;
  let totalSkipped = 0;

  for (const repo of repos) {
    const label = path.basename(repo);
    const { added, skipped } = await learnFromRepo({ ...base, repoPath: repo, label });
    totalAdded += added;
    totalSkipped += skipped;
  }

  console.log(
    `Git learn complete: ${totalAdded} new lessons added, ` +
      `${totalSkipped} duplicates skipped across ${repos.length} repos.`,
  );
}
