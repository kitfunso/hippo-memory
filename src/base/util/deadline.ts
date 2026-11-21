// Node fires a longer setTimeout after 1 ms, so a huge deadline is clamped to its ceiling.
const MAX_TIMER_MS = 2_147_483_647;

/** Thrown by withDeadline when the callback misses its deadline. */
export class DeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`no answer within ${deadlineMs} ms`);
    this.name = 'DeadlineError';
  }
}

function isCallable<F>(value: F | undefined): value is F {
  return typeof value === 'function';
}

function adopt<T>(out: T | Promise<T>, stamp: () => void): Promise<T> {
  // Promises/A+ 2.3.3: read `then` once, call it through the intrinsic call, and let the first reaction win.
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const ok = (value: T | Promise<T>): void => {
      if (settled) return;
      settled = true;
      resolve(adopt(value, stamp));
    };
    const fail: typeof reject = (err) => {
      if (settled) return;
      settled = true;
      stamp();
      reject(err);
    };
    try {
      const then: Promise<T>['then'] | undefined = Object(out).then;
      if (isCallable(then)) {
        Function.prototype.call.call(then, out, ok, fail);
      } else {
        stamp();
        resolve(out);
      }
    } catch (err) {
      fail(err);
    }
  });
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
    called = adopt(run(abort.signal), stamp);
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
