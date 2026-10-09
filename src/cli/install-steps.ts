// The init and setup steps that touch the machine: Codex hooks, the settings.json warning and the daily schedule.

import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import { installJsonHooks, type InstallResult } from '../hooks/json-hooks.js';
import { CODEX_TRUST_LINE } from '../hooks/shared.js';
import { DAILY_TASK_NAME, buildDailyRunnerCommand, hasUnsafeRunnerPathChars, buildSchtasksCreateArgs, buildWindowsTaskRun, quoteInsideWindowsArg } from './scheduler.js';

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
/** Bound on each schtasks and crontab call, so a scheduler that never answers cannot hang `hippo init` or `hippo setup`. */
const SCHEDULER_CALL_TIMEOUT_MS = 30_000;

/** Node kills a child at its timeout and reports ETIMEDOUT; every other failure here means the scheduler refused or is missing. */
function schedulerTimedOut<E>(err: E): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ETIMEDOUT';
}

function warnSchedulerTimedOut(command: string): void {
  console.log(`   ${command} did not answer within ${SCHEDULER_CALL_TIMEOUT_MS / 1000} s and was stopped, so the daily runner is not scheduled.`);
}

export function setupDailySchedule(globalRoot: string): void {
  const runnerDir = path.resolve(globalRoot);
  if (hasUnsafeRunnerPathChars(runnerDir, process.platform)) {
    console.log(`   Skipping schedule: runner path contains unsafe characters.`);
    return;
  }
  const isWindows = process.platform === 'win32';
  const taskName = DAILY_TASK_NAME;
  const cmd = buildDailyRunnerCommand(runnerDir);

  if (isWindows) scheduleOnWindows(taskName, cmd);
  else scheduleOnCrontab(taskName, cmd);
}

function scheduleOnWindows(taskName: string, cmd: string): void {
  // Check if task already exists
  try {
    const existing = execSync(`schtasks /query /tn "${taskName}" 2>nul`, { encoding: 'utf-8', windowsHide: true, timeout: SCHEDULER_CALL_TIMEOUT_MS });
    if (existing.includes(taskName)) {
      return; // already scheduled
    }
  } catch (err) {
    // A non-zero exit means the task does not exist yet, so it is created below.
    if (schedulerTimedOut(err)) warnSchedulerTimedOut('schtasks /query');
  }

  try {
    execFileSync('schtasks', buildSchtasksCreateArgs(taskName, cmd), { stdio: 'pipe', windowsHide: true, timeout: SCHEDULER_CALL_TIMEOUT_MS });
    console.log(`   Scheduled machine-level daily runner (6:15am) via Task Scheduler: ${taskName}`);
  } catch (err) {
    if (schedulerTimedOut(err)) warnSchedulerTimedOut('schtasks /create');
    // No admin rights or schtasks unavailable, fall back to printing instructions
    console.log(`   To schedule the machine-level daily runner, run:`);
    console.log(`   schtasks /create /tn "${taskName}" /tr "${quoteInsideWindowsArg(buildWindowsTaskRun(cmd))}" /sc daily /st 06:15`);
  }
}

function scheduleOnCrontab(taskName: string, cmd: string): void {
  // Unix: check crontab for existing entry
  const marker = `# hippo:${taskName}`;
  try {
    const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8', windowsHide: true, timeout: SCHEDULER_CALL_TIMEOUT_MS });
    if (existing.includes(marker)) {
      return; // already scheduled
    }

    const cronLine = `15 6 * * * ${cmd} ${marker}`;
    const newCrontab = existing.trimEnd() + '\n' + cronLine + '\n';
    execSync('crontab -', { input: newCrontab, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: SCHEDULER_CALL_TIMEOUT_MS });
    console.log(`   Scheduled machine-level daily runner (6:15am) via crontab`);
  } catch (err) {
    if (schedulerTimedOut(err)) warnSchedulerTimedOut('crontab');
    // No crontab or no permission: print the line for the user to add by hand.
    const cronLine = `15 6 * * * ${cmd}`;
    console.log(`   To schedule the machine-level daily runner, add to crontab (crontab -e):`);
    console.log(`   ${cronLine}`);
  }
}
