import { HOUR_MS, MINUTE_MS } from '../../base/util/time.js';
import { pruneSessionFiles } from '../capture/session-worker.js';
import type { Log } from '../../infra/spool-files.js';
import { execFileSync } from 'node:child_process';
import { isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { importUserMemories } from '../../api/agent-memories.js';
import { currentMachine } from '../../infra/machine.js';
import { cliApiContext, cliStore, cliSyncOptions } from './api-context.js';
import { lastSleepAt } from '../../api/status.js';
import { listRegisteredWorkspaces, runDailyMaintenance } from './scheduler.js';
import { replayCompactions } from '../capture/compaction-record.js';
import { errorCode, errorFields, errorMessage, log } from '../../base/util/log.js';
import { envDailyStepTimeoutMs } from '../../base/util/env.js';
import { type CommandContext } from './flag-values.js';
import { printAgentImport } from './print.js';
import { repairQualityOnce } from './quality-repair-once.js';
import { plural } from '../../base/util/format.js';

const DAILY_STEP_TIMEOUT_MS = 30 * MINUTE_MS;

function dailyStepFailure<E>(err: E, timeoutMs: number): string {
  if (errorCode(err) === 'ETIMEDOUT') {
    return `timed out after ${timeoutMs} ms and was stopped`;
  }
  return errorMessage(err);
}

export async function handleDailyRunner({ tenantId }: CommandContext): Promise<void> {
  const globalRoot = hippoHomeDir();
  if (isInitialized(globalRoot)) await finishGlobalCompactions(globalRoot, tenantId);
  printAgentImport(
    await importUserMemories(globalRoot, cliSyncOptions(tenantId, currentMachine())),
    '',
  );
  const workspaces = listRegisteredWorkspaces(globalRoot);

  const { runStep, counts } = dailyStepRunner(envDailyStepTimeoutMs() ?? DAILY_STEP_TIMEOUT_MS);
  if (isInitialized(globalRoot)) await sleepGlobalStore(globalRoot, tenantId, runStep);

  if (workspaces.length === 0) {
    console.log('No registered Hippo workspaces found. Run `hippo init` inside a project first.');
  } else {
    console.log(
      `Running daily maintenance across ${plural(workspaces.length, 'registered workspace')}...`,
    );
    runDailyMaintenance(workspaces, runStep, globalRoot);
  }
  reportDailyRun(counts.processed, counts.failed);
}

async function finishGlobalCompactions(globalRoot: string, tenantId: string): Promise<void> {
  const warn: Log = (message, fields) => log.warn(`compaction replay: ${message}`, fields);
  const finished = await replayCompactions(
    { root: globalRoot, store: cliStore(globalRoot), tenantId },
    warn,
  );
  if (finished > 0) {
    console.log(`Finished saving ${plural(finished, 'compaction')} left over in the global store.`);
  }
  pruneSessionFiles(Date.now());
  await repairQualityOnce(globalRoot, tenantId);
}

interface DailyStepRunner {
  readonly runStep: (cwd: string, args: string[]) => void;
  readonly counts: { processed: number; failed: number };
}

function dailyStepRunner(timeout: number): DailyStepRunner {
  const counts = { processed: 0, failed: 0 };
  const runStep = (cwd: string, args: string[]): void => {
    try {
      execFileSync(process.execPath, [process.argv[1], ...args], {
        cwd,
        stdio: 'inherit',
        windowsHide: true,
        timeout,
      });
      if (args[0] === 'sleep') counts.processed++;
    } catch (err) {
      counts.failed++;
      const action = args.join(' ');
      log.error(
        `daily-runner failed in ${cwd} during \`${action}\`: ${dailyStepFailure(err, timeout)}`,
        {
          workspace: cwd,
          ...errorFields(err),
        },
      );
    }
  };
  return { runStep, counts };
}

const GLOBAL_SLEEP_GAP_MS = 20 * HOUR_MS;

async function sleepGlobalStore(
  globalRoot: string,
  tenantId: string,
  runStep: (cwd: string, args: string[]) => void,
): Promise<void> {
  let last: string | undefined;
  try {
    last = await lastSleepAt(cliApiContext(globalRoot, tenantId));
  } catch (err) {
    log.warn(
      `could not read the global store's last sleep: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
  if (last !== undefined && Date.now() - Date.parse(last) < GLOBAL_SLEEP_GAP_MS) {
    console.log(`Skipped the global store: it slept at ${last}, less than 20 hours ago.`);
    return;
  }
  runStep(process.cwd(), ['sleep', '--global', '--no-learn']);
}

function reportDailyRun(processed: number, failed: number): void {
  console.log(
    `Daily maintenance complete: ${plural(processed, 'workspace')} processed, ` +
      `${plural(failed, 'command failure')}.`,
  );
  if (failed > 0) process.exitCode = 1;
}
