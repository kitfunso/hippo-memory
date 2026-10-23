// `hippo codex-run`: launches the real Codex, then starts the session-end worker once Codex exits.
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { installedRealCodexPath, resolveCodexWrapperPaths } from '../../hooks-install/codex-wrapper.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { exitAfterFlush } from '../../../base/util/crash-handlers.js';
import { ignoringCodes } from '../../../base/util/expected-errors.js';
import { cmdShimArgs, npmShimEntry } from '../../../host/spawn-argv.js';
import { printError } from '../output.js';
import { handleLastSleep } from '../last-sleep.js';
import type { CommandContext } from '../flag-values.js';
import { handleCodexSessionEndWorker } from './codex-session-end-worker.js';

function spawnRealCodex(realCodexPath: string, forwardArgs: string[], cwd: string): ReturnType<typeof spawn> {
  const ext = path.extname(realCodexPath).toLowerCase();

  if (process.platform === 'win32' && ext === '.ps1') {
    // Node runs the shim's script directly: no PowerShell, no execution-policy bypass, no shell parsing the arguments.
    const entry = npmShimEntry(realCodexPath);
    if (entry === null) {
      throw new Error(`${realCodexPath} is not an npm shim whose script hippo can find, so Codex was not started.`);
    }
    return spawn(process.execPath, [entry, ...forwardArgs], { cwd, stdio: 'inherit', windowsHide: false });
  }

  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return spawn('cmd.exe', cmdShimArgs(realCodexPath, forwardArgs), {
      cwd,
      stdio: 'inherit',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(realCodexPath, forwardArgs, { cwd, stdio: 'inherit', windowsHide: false });
}

export function handleCodexRun({ hippoRoot, tenantId, args }: CommandContext): void {
  const realCodexPath = installedRealCodexPath();
  const startedAtMs = Date.now();
  // Codex reads CODEX_HOME at each launch, so resolve it now; the log path is the installer's own, never the file's.
  const { historyPath, logFile } = resolveCodexWrapperPaths();
  const startOffsetBytes = fs.existsSync(historyPath) ? fs.statSync(historyPath).size : 0;

  try {
    handleLastSleep({ hippoRoot, flags: { path: logFile } }, 'terminal');
  } catch (err) {
    log.debug(`codex run: the last sleep summary was not shown: ${errorMessage(err)}`, errorFields(err));
  }

  const child = spawnRealCodex(realCodexPath, args, process.cwd());
  child.on('error', (err) => {
    printError(`Failed to launch Codex: ${err.message}`);
    exitAfterFlush(1);
  });

  child.on('exit', async (code, signal) => {
    await launchCodexSessionEndWorker({ hippoRoot, tenantId, historyPath, startOffsetBytes, startedAtMs, logFile });
    exitLikeChild(code, signal);
  });
}

interface CodexSessionEndWorkerOptions {
  hippoRoot: string;
  tenantId: string;
  historyPath: string;
  startOffsetBytes: number;
  startedAtMs: number;
  logFile: string;
}

async function launchCodexSessionEndWorker(options: CodexSessionEndWorkerOptions): Promise<void> {
  const { hippoRoot, tenantId, historyPath, startOffsetBytes, startedAtMs, logFile } = options;
  const workerArgs = [
    process.argv[1],
    '__codex-session-end-worker',
    '--codex-home',
    path.dirname(historyPath),
    '--history-path',
    historyPath,
    '--start-offset',
    String(startOffsetBytes),
    '--started-at',
    String(startedAtMs),
    '--log-file',
    logFile,
  ];

  if (await detachedWorkerStarted(workerArgs)) return;
  // Awaited so the sleep write can't be killed by the exit calls below.
  try {
    await handleCodexSessionEndWorker({
      hippoRoot,
      tenantId,
      args: [],
      flags: {
        'codex-home': path.dirname(historyPath),
        'history-path': historyPath,
        'start-offset': String(startOffsetBytes),
        'started-at': String(startedAtMs),
        'log-file': logFile,
      },
    });
  } catch (inlineErr) {
    log.debug(`codex run: the inline session-end failed: ${errorMessage(inlineErr)}`, errorFields(inlineErr));
  }
}

/**
 * Resolves true once the detached worker is running, false when the spawn fails, whether it throws or reports later.
 */
function detachedWorkerStarted(workerArgs: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const failed = <E>(err: E): void => {
      log.warn(
        `codex run: the session-end worker did not spawn, running inline: ${errorMessage(err)}`,
        errorFields(err),
      );
      resolve(false);
    };
    try {
      const worker = spawn(process.execPath, workerArgs, { detached: true, stdio: 'ignore', windowsHide: true });
      // An async spawn failure (ENOENT, EAGAIN) arrives as an 'error' event, which a try cannot catch.
      worker.on('error', failed);
      worker.once('spawn', () => resolve(true));
      worker.unref();
    } catch (err) {
      failed(err);
    }
  });
}

function exitLikeChild(code: number | null, signal: NodeJS.Signals | null): void {
  if (signal) {
    // Cannot re-raise the child's signal on this platform; a non-zero exit still reports the failure.
    const raised = ignoringCodes(['ESRCH', 'EPERM', 'ENOSYS', 'ERR_UNKNOWN_SIGNAL'], () =>
      process.kill(process.pid, signal),
    );
    if (raised === undefined) process.exit(1);
    return;
  }
  process.exit(code ?? 0);
}
