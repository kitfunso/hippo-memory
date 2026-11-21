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
  const start = performance.now();
  // The stamp sits on the callback, since a later block on the thread is not the callback's lateness.
  let doneAt: number | undefined;
  const stamp = (): void => {
    doneAt = performance.now();
  };
  let called: Promise<T>;
  try {
    const out = run(abort.signal);
    if (out instanceof Promise) {
      called = out.finally(stamp);
    } else {
      stamp();
      called = Promise.resolve(out);
    }
  } catch (err) {
    stamp();
    called = Promise.reject(err);
  }
  const isLate = (): boolean => doneAt === undefined || doneAt - start >= deadlineMs;
  try {
    const result = await Promise.race([called, deadline]);
    if (!isLate()) return result;
  } catch (err) {
    if (!isLate()) throw err;
  } finally {
    clearTimeout(timer);
  }
  const late = new DeadlineError(deadlineMs);
  if (!abort.signal.aborted) abort.abort(late);
  throw late;
}
