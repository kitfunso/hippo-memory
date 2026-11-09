// The init and setup steps that touch the machine: Codex hooks, the settings.json warning and the
// daily schedule.

import * as path from 'node:path';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import type { InstallResult } from '../hooks-install/rules/json-hooks.js';
import { CODEX_TRUST_LINE, installJsonHooks } from '../hooks-install/json-hooks.js';
import { envSkipSchedule } from '../../base/util/env.js';
import { errorCode, errorFields, errorMessage, log } from '../../base/util/log.js';
import {
  DAILY_TASK_NAME,
  buildDailyRunnerCommand,
  hasUnsafeRunnerPathChars,
  buildSchtasksCreateArgs,
  buildWindowsTaskRun,
  quoteInsideWindowsArg,
} from './scheduler.js';

/**
 * Adds hippo's two Codex hooks and says what changed; each install ends on the trust reminder,
 * since Codex skips an untrusted hook.
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
 * The one line init, hook install, hook uninstall and setup print when Claude Code's
 * settings.json is not JSON hippo can edit and so was left unchanged; true when it printed. */
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
 * Machine-level daily runner sweeping all registered workspaces: user crontab on Linux/macOS, a
 * scheduled task on Windows; skips if installed.
 */
/**
 * Bound on each schtasks and crontab call, so a scheduler that never answers cannot hang `hippo
 * init` or `hippo setup`.
 */
const SCHEDULER_CALL_TIMEOUT_MS = 30_000;
// Piped stderr stands in for `2>nul` and `2>/dev/null`, so no shell is needed to keep the
// scheduler's complaints off the terminal.
const SCHEDULER_CALL: ExecFileSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  stdio: 'pipe',
  windowsHide: true,
  timeout: SCHEDULER_CALL_TIMEOUT_MS,
};

/** Runs one scheduler program from argv with no shell; tests hand in a stand-in so no real
 * schtasks or crontab runs. */
type RunScheduler = (
  file: string,
  args: readonly string[],
  opts: ExecFileSyncOptionsWithStringEncoding,
) => string;

/**
 * Node kills a child at its timeout and reports ETIMEDOUT; every other failure here means the
 * scheduler refused or is missing.
 */
function schedulerTimedOut<E>(err: E): boolean {
  return errorCode(err) === 'ETIMEDOUT';
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
  // The path rules follow the platform being scheduled for, so a Windows root is never judged by
  // POSIX rules.
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
    if (schedulerTimedOut(err)) {
      // An unanswered query may hide an existing task, so nothing is created over it.
      console.log(
        `   schtasks /query did not answer within ${SCHEDULER_CALL_TIMEOUT_MS / 1000} s and was stopped, so Task ` +
          `Scheduler was not changed; run hippo init again, or check for the task ${taskName}.`,
      );
      return;
    }
    // Any other non-zero exit means the task does not exist yet, so it is created below.
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

const dailyCronLine = (cmd: string, marker: string): string => `15 6 * * * ${cmd} ${marker}`;

// The five schedule fields or an @macro, with any leading blanks.
const CRON_SCHEDULE = /^\s*(?:@\S+|\S+(?:\s+\S+){4})(?=\s|$)/;

/** Where `marker` stands in `line` as a whole token, or -1; `<marker>-old` is another name. */
function markerAt(line: string, marker: string): number {
  const blankOrEdge = (i: number): boolean => i < 0 || i >= line.length || /\s/.test(line[i]);
  for (let at = line.indexOf(marker); at >= 0; at = line.indexOf(marker, at + 1)) {
    if (blankOrEdge(at - 1) && blankOrEdge(at + marker.length)) return at;
  }
  return -1;
}

/** `line` with its command replaced by `cmd`, schedule and marker kept; null when it has no schedule. */
function withCommand(line: string, at: number, cmd: string): string | null {
  const schedule = CRON_SCHEDULE.exec(line)?.[0];
  if (schedule === undefined || at < schedule.length) return null;
  return line.slice(schedule.length, at).trim() === cmd
    ? line
    : `${schedule} ${cmd} ${line.slice(at)}`;
}

type CrontabPlan =
  | { readonly kind: 'keep' }
  | { readonly kind: 'unreadable'; readonly line: string }
  | { readonly kind: 'write'; readonly text: string; readonly said: readonly string[] };

function appendEntry(existing: string, marker: string, cmd: string): CrontabPlan {
  // A user with no crontab yet gets the line alone, with no blank line above it.
  const kept = existing.trimEnd();
  return {
    kind: 'write',
    text: `${kept === '' ? '' : `${kept}\n`}${dailyCronLine(cmd, marker)}\n`,
    said: ['   Scheduled machine-level daily runner (6:15am) via crontab'],
  };
}

/**
 * What to do with the user's crontab so it holds exactly one active line for the daily runner.
 * Every other line is kept as it was, line endings included.
 */
function reconcileCrontab(existing: string, marker: string, cmd: string): CrontabPlan {
  const lines = existing.split('\n');
  const isEntry = (line: string): boolean => !/^\s*#/.test(line) && markerAt(line, marker) >= 0;
  const [first, ...extra] = lines.flatMap((line, i) => (isEntry(line) ? [i] : []));
  if (first === undefined) return appendEntry(existing, marker, cmd);
  const old = lines[first];
  const fresh = withCommand(old, markerAt(old, marker), cmd);
  if (fresh === null) return { kind: 'unreadable', line: old.trim() };
  if (fresh === old && extra.length === 0) return { kind: 'keep' };
  const said = [
    ...(fresh === old
      ? []
      : [
          '   Updated the daily runner entry in your crontab (the command changed).',
          `   was: ${old.trimEnd()}`,
          `   now: ${fresh.trimEnd()}`,
        ]),
    ...extra.flatMap((i) => [
      '   Removed a duplicate daily runner entry from your crontab:',
      `   ${lines[i].trimEnd()}`,
    ]),
  ];
  const text = lines
    .map((line, i) => (i === first ? fresh : line))
    .filter((_, i) => !extra.includes(i))
    .join('\n');
  return { kind: 'write', text: text.endsWith('\n') ? text : `${text}\n`, said };
}

function scheduleOnCrontab(taskName: string, cmd: string, run: RunScheduler): void {
  const marker = `# hippo:${taskName}`;
  try {
    const plan = reconcileCrontab(readCrontab(run), marker, cmd);
    if (plan.kind === 'keep') return; // already scheduled
    if (plan.kind === 'unreadable') {
      log.warn(
        `install: the daily runner line in your crontab is not a cron schedule hippo can read, so it was left as it ` +
          `is: ${plan.line}`,
      );
      return;
    }
    run('crontab', ['-'], { ...SCHEDULER_CALL, input: plan.text });
    for (const line of plan.said) console.log(line);
  } catch (err) {
    if (schedulerTimedOut(err)) warnSchedulerTimedOut('crontab');
    log.warn(
      `install: crontab could not be read or written, so the daily runner is not scheduled: ${errorMessage(err)}`,
      errorFields(err),
    );
    // No permission or no crontab program: print the line for the user to add by hand.
    console.log(`   To schedule the machine-level daily runner, add to crontab (crontab -e):`);
    console.log(`   ${dailyCronLine(cmd, marker)}`);
  }
}
