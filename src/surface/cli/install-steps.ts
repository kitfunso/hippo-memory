// The init and setup steps that touch the machine: Codex hooks, the settings.json warning and the daily schedule.

import * as path from 'path';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import { installJsonHooks, type InstallResult } from '../../domain/hooks/json-hooks.js';
import { CODEX_TRUST_LINE } from '../../domain/hooks/shared.js';
import { envSkipSchedule } from '../../base/util/env.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import {
  DAILY_TASK_NAME,
  buildDailyRunnerCommand,
  hasUnsafeRunnerPathChars,
  buildSchtasksCreateArgs,
  buildWindowsTaskRun,
  quoteInsideWindowsArg,
} from './scheduler.js';

/**
 * Adds hippo's two Codex hooks and says what changed; each install ends on the trust reminder, since Codex skips an
 * untrusted hook.
 */
export function installCodexMemoryHooks(indent: string): void {
  const result = installJsonHooks('codex');
  if (result.invalidJson) {
    console.log(
      `${indent}WARNING: ${result.settingsPath} is not a hooks file hippo can merge into; fix it, then run \`hippo ` +
        `hook install codex\`.`,
    );
    return;
  }
  const added = [
    result.installedUserPromptSubmit ? 'UserPromptSubmit' : '',
    result.installedCompactResume ? 'SessionStart(compact)' : '',
  ].filter(Boolean);
  console.log(
    added.length > 0
      ? `${indent}Installed hippo's Codex memory hooks (${added.join(', ')}) in ${result.settingsPath}`
      : `${indent}hippo's Codex memory hooks already in ${result.settingsPath}`,
  );
  console.log(`${indent}${CODEX_TRUST_LINE}`);
}

/**
 * The one line init, hook install, hook uninstall and setup print when Claude Code's settings.json is not JSON hippo
 * can edit and so was left unchanged; true when it printed. */
export function warnClaudeSettingsUnusable(
  result: Pick<InstallResult, 'settingsPath' | 'invalidJson'>,
  indent: string,
  action: 'install' | 'uninstall' = 'install',
): boolean {
  if (!result.invalidJson) return false;
  console.log(
    `${indent}WARNING: ${result.settingsPath} is not a JSON object hippo can merge into, so it was left unchanged; ` +
      `fix it, then run \`hippo hook ${action} claude-code\`.`,
  );
  return true;
}

/**
 * Machine-level daily runner sweeping all registered workspaces: user crontab on Linux/macOS, a scheduled task on
 * Windows; skips if installed.
 */
/**
 * Bound on each schtasks and crontab call, so a scheduler that never answers cannot hang `hippo init` or `hippo setup`.
 */
const SCHEDULER_CALL_TIMEOUT_MS = 30_000;
// Piped stderr stands in for `2>nul` and `2>/dev/null`, so no shell is needed to keep the scheduler's complaints off
// the terminal.
const SCHEDULER_CALL: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: 'pipe',
  windowsHide: true,
  timeout: SCHEDULER_CALL_TIMEOUT_MS,
};

/** Runs one scheduler program from argv with no shell; tests hand in a stand-in so no real schtasks or crontab runs. */
type RunScheduler = (file: string, args: readonly string[], opts: ExecFileSyncOptionsWithStringEncoding) => string;

/**
 * Node kills a child at its timeout and reports ETIMEDOUT; every other failure here means the scheduler refused or is
 * missing.
 */
function schedulerTimedOut<E>(err: E): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ETIMEDOUT';
}

function warnSchedulerTimedOut(command: string): void {
  console.log(
    `   ${command} did not answer within ${SCHEDULER_CALL_TIMEOUT_MS / 1000} s and was stopped, so the daily runner ` +
      `is not scheduled.`,
  );
}

export function setupDailySchedule(
  globalRoot: string,
  run: RunScheduler = execFileSync,
  platform: NodeJS.Platform = process.platform,
): void {
  // Checked here, not per caller, so init, init --scan and setup all honour it.
  if (envSkipSchedule()) {
    console.log('   HIPPO_SKIP_SCHEDULE=1, so the machine-level daily runner was not scheduled.');
    return;
  }
  const isWindows = platform === 'win32';
  // The path rules follow the platform being scheduled for, so a Windows root is never judged by POSIX rules.
  const runnerDir = (isWindows ? path.win32 : path.posix).resolve(globalRoot);
  if (hasUnsafeRunnerPathChars(runnerDir, platform)) {
    console.log(`   Skipping schedule: runner path contains unsafe characters.`);
    return;
  }
  const taskName = DAILY_TASK_NAME;
  const cmd = buildDailyRunnerCommand(runnerDir, platform);

  if (isWindows) scheduleOnWindows(taskName, cmd, run);
  else scheduleOnCrontab(taskName, cmd, run);
}

function scheduleOnWindows(taskName: string, cmd: string, run: RunScheduler): void {
  try {
    const existing = run('schtasks', ['/query', '/tn', taskName], SCHEDULER_CALL);
    if (existing.includes(taskName)) {
      return; // already scheduled
    }
  } catch (err) {
    // A non-zero exit means the task does not exist yet, so it is created below.
    if (schedulerTimedOut(err)) warnSchedulerTimedOut('schtasks /query');
  }

  try {
    run('schtasks', buildSchtasksCreateArgs(taskName, cmd), SCHEDULER_CALL);
    console.log(`   Scheduled machine-level daily runner (6:15am) via Task Scheduler: ${taskName}`);
  } catch (err) {
    if (schedulerTimedOut(err)) warnSchedulerTimedOut('schtasks /create');
    // No admin rights or schtasks unavailable, fall back to printing instructions
    console.log(`   To schedule the machine-level daily runner, run:`);
    console.log(
      `   schtasks /create /tn "${taskName}" /tr "${quoteInsideWindowsArg(buildWindowsTaskRun(cmd))}" /sc daily /st ` +
        `06:15`,
    );
  }
}

/** `crontab -l` exits 1 with "no crontab for <user>" when the user has none yet. */
function hasNoCrontabYet<E>(err: E): boolean {
  return (
    err instanceof Error &&
    'status' in err &&
    err.status === 1 &&
    'stderr' in err &&
    /no crontab for/i.test(String(err.stderr))
  );
}

/** The user's crontab; a user with none has an empty one, and any other failure throws. */
function readCrontab(run: RunScheduler): string {
  try {
    return run('crontab', ['-l'], SCHEDULER_CALL);
  } catch (err) {
    if (hasNoCrontabYet(err)) return '';
    throw err;
  }
}

function scheduleOnCrontab(taskName: string, cmd: string, run: RunScheduler): void {
  const marker = `# hippo:${taskName}`;
  try {
    const existing = readCrontab(run);
    if (existing.includes(marker)) {
      return; // already scheduled
    }

    const cronLine = `15 6 * * * ${cmd} ${marker}`;
    // A user with no crontab yet gets the line alone, with no blank line above it.
    const kept = existing.trimEnd();
    const newCrontab = `${kept === '' ? '' : `${kept}\n`}${cronLine}\n`;
    run('crontab', ['-'], { ...SCHEDULER_CALL, input: newCrontab });
    console.log(`   Scheduled machine-level daily runner (6:15am) via crontab`);
  } catch (err) {
    if (schedulerTimedOut(err)) warnSchedulerTimedOut('crontab');
    log.warn(
      `install: crontab could not be read or written, so the daily runner is not scheduled: ${errorMessage(err)}`,
      errorFields(err),
    );
    // No permission or no crontab program: print the line for the user to add by hand.
    const cronLine = `15 6 * * * ${cmd}`;
    console.log(`   To schedule the machine-level daily runner, add to crontab (crontab -e):`);
    console.log(`   ${cronLine}`);
  }
}
