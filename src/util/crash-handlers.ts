// Last-resort process handlers shared by the long-running entry points (`hippo mcp`, `hippo serve`).
import { errorFields, errorMessage, log } from '../log.js';

/** Exit once stdout and stderr have drained, so the last reply and the crash log reach their reader; capped at 1 s. */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = (): void => { if (--pending === 0) process.exit(code); };
  process.stdout.write('', done);
  process.stderr.write('', done);
  setTimeout(() => process.exit(code), 1000).unref();
}

/** After an uncaught throw the process state is unknown: log the cause, run `shutdown` once, then exit 1 for the supervisor or client to restart it. */
export function installCrashHandlers(name: string, shutdown: () => void | Promise<void> = () => {}): void {
  let crashing = false;
  const crash = <E>(kind: string, err: E): void => {
    log.error(`${name} ${kind}: ${errorMessage(err)}`, errorFields(err));
    // A throw while shutdown runs is logged above and must not start it again.
    if (crashing) return;
    crashing = true;
    Promise.resolve()
      .then(shutdown)
      .catch(<S>(shutdownErr: S) => log.error(`${name} shutdown after ${kind} failed: ${errorMessage(shutdownErr)}`, errorFields(shutdownErr)))
      .finally(() => exitAfterFlush(1));
  };
  process.on('uncaughtException', (err) => crash('uncaught exception', err));
  process.on('unhandledRejection', (err) => crash('unhandled rejection', err));
}
