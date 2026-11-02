import { types } from 'node:util';
import { runInNewContext } from 'node:vm';

/** The hostile input size: linear scans take well under a second, quadratic ones hours. */
export const ONE_MIB = 1024 * 1024;

/** Far past a linear scan of ONE_MIB on a loaded runner, so only a super-linear pattern reaches it. */
export const WATCHDOG_MS = 15_000;

/**
 * Runs `scan(text)` under a watchdog that stops the thread itself, which a test timeout cannot do to synchronous
 * code. A regex that backtracks super-linearly on `text` is cut off at `deadlineMs` and fails here, instead of
 * hanging the run; linear work finishes in a small fraction of any sensible deadline.
 */
export function scanWithinWatchdog<T>(scan: (text: string) => T, text: string, deadlineMs: number): T {
  try {
    return runInNewContext('scan(text)', { scan, text }, { timeout: deadlineMs });
  } catch (err) {
    // The watchdog's error comes from the other realm, which an instanceof check cannot see.
    if (types.isNativeError(err) && 'code' in err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(
        `scanning ${text.length} characters did not finish within ${deadlineMs} ms: a pattern is super-linear`,
        {
          cause: err,
        },
      );
    }
    throw err;
  }
}

/** `unit` repeated and cut to exactly `size` characters. */
export function fillTo(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}
