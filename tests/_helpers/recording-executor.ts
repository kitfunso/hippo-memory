// A store executor that records each call it is handed, so a test can tell which ops crossed to a
// worker and with which request limits.
import type { CallOptions, SqliteExecutor } from '../../src/store/sqlite/runtime/executor.js';

export interface SentCall {
  readonly op: string;
  readonly mode: string;
  readonly deadlineAt: number | undefined;
  readonly signal: AbortSignal | undefined;
}

/** `inner` with each call it is handed recorded; with no `inner`, each call answers at once and
 * runs nowhere. `handed` settles once `op` has been handed over `times` times. */
export function recordingExecutor(inner?: SqliteExecutor) {
  const sent: SentCall[] = [];
  const checks: Array<() => void> = [];
  const executor: SqliteExecutor = {
    call: <T>(op: string, args: readonly unknown[], opts: CallOptions): Promise<T> => {
      sent.push({ op, mode: opts.mode, deadlineAt: opts.deadlineAt, signal: opts.signal });
      for (const check of checks) check();
      // SAFETY: with no inner executor the caller reads only what was sent, never the answer.
      return inner ? inner.call<T>(op, args, opts) : Promise.resolve(undefined as T);
    },
    close: async () => {
      await inner?.close();
    },
    liveThreads: () => inner?.liveThreads() ?? 0,
    terminateWriter: () => inner?.terminateWriter(),
  };
  const handed = (op: string, times = 1): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (sent.filter((call) => call.op === op).length >= times) resolve();
      };
      checks.push(check);
      check();
    });
  return { executor, sent, handed };
}
