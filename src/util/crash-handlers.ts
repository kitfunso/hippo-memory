// Last-resort process handlers shared by the long-running entry points (`hippo mcp`, `hippo serve`).
import { errorFields, errorMessage, log } from './log.js';

/** What an entry point runs before it exits, and how long that may take before the process is ended without it. */
export interface Shutdown {
  readonly run: () => void | Promise<void>;
  readonly boundMs: number;
}

function afterFlush(leave: () => void): void {
  let pending = 2;
  const done = (): void => { if (--pending === 0) leave(); };
  process.stdout.write('', done);
  process.stderr.write('', done);
  setTimeout(leave, 1000).unref();
}

/** Exit once stdout and stderr have drained, so the last reply and the last log line reach their reader; capped at 1 s. */
export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  afterFlush(() => process.exit(code));
}

// process.exit joins every worker thread, so one stuck in a synchronous statement would hold the exit open; a kill cannot be held.
function killSelf(): void {
  process.kill(process.pid, 'SIGKILL');
}

/** Runs `shutdown` for `cause`, then exits with `code`, or 1 when it threw. One still running after its bound is logged and the process ended without it. */
function exitAfterShutdown(name: string, cause: string, shutdown: Shutdown, code: number): void {
  let ended = false;
  // Referenced on purpose: a shutdown that never settles must end at the bound, not when the loop happens to empty.
  const bound = setTimeout(() => {
    ended = true;
    log.error(`${name} shutdown after ${cause} did not finish within ${shutdown.boundMs} ms; ending the process without it`);
    process.exitCode = 1;
    afterFlush(killSelf);
  }, shutdown.boundMs);
  void Promise.resolve()
    .then(shutdown.run)
    .then(() => code, <E>(err: E) => {
      log.error(`${name} shutdown after ${cause} failed: ${errorMessage(err)}`, errorFields(err));
      return 1;
    })
    .then((exitCode) => {
      clearTimeout(bound);
      if (!ended) exitAfterFlush(exitCode);
    });
}

/** On SIGTERM or SIGINT: runs `shutdown` once, then exits 0. */
export function installSignalHandlers(name: string, shutdown: Shutdown): void {
  let shuttingDown = false;
  const stopFor = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`received ${signal}, shutting down`);
    exitAfterShutdown(name, signal, shutdown, 0);
  };
  process.once('SIGTERM', () => stopFor('SIGTERM'));
  process.once('SIGINT', () => stopFor('SIGINT'));
}

/** After an uncaught throw the process state is unknown: log the cause, run `shutdown` once, then exit 1 for the supervisor or client to restart it. */
export function installCrashHandlers(name: string, shutdown?: Shutdown): void {
  let crashing = false;
  const crash = <E>(kind: string, err: E): void => {
    log.error(`${name} ${kind}: ${errorMessage(err)}`, errorFields(err));
    // A throw while shutdown runs is logged above and must not start it again.
    if (crashing) return;
    crashing = true;
    if (shutdown) exitAfterShutdown(name, kind, shutdown, 1);
    else exitAfterFlush(1);
  };
  process.on('uncaughtException', (err) => crash('uncaught exception', err));
  process.on('unhandledRejection', (err) => crash('unhandled rejection', err));
}
