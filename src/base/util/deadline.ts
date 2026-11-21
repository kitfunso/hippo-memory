// Node fires a longer setTimeout after 1 ms, so a huge deadline is clamped to its ceiling.
const MAX_TIMER_MS = 2_147_483_647;

/** Thrown by withDeadline when the callback misses its deadline. */
export class DeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`no answer within ${deadlineMs} ms`);
    this.name = 'DeadlineError';
  }
}

/** Runs `run` against a deadline: past it the signal aborts and the call rejects with DeadlineError. */
export async function withDeadline<T>(
  deadlineMs: number,
  run: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        const late = new DeadlineError(deadlineMs);
        abort.abort(late);
        reject(late);
      },
      Math.min(deadlineMs, MAX_TIMER_MS),
    );
  });
  // A callback that blocks the thread never lets the timer fire, so the clock is read once it settles.
  const start = performance.now();
  const failIfLate = (): void => {
    if (performance.now() - start < deadlineMs) return;
    const late = new DeadlineError(deadlineMs);
    if (!abort.signal.aborted) abort.abort(late);
    throw late;
  };
  let result: T;
  try {
    result = await Promise.race([(async () => run(abort.signal))(), deadline]);
  } catch (err) {
    failIfLate();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  failIfLate();
  return result;
}
