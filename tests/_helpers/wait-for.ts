/** The default deadline of an awaited event: a test's own wait never runs past it unless it names why. */
export const EVENT_DEADLINE_MS = 10_000;
/** The longest any wait or child run may take, so it fails before vitest's 60 s worker RPC timeout does. */
export const HANG_GUARD_MS = 45_000;

/** Throws RangeError for a deadline past the hang guard, or past EVENT_DEADLINE_MS with no reason, so each long wait says why in one greppable place. */
export function checkDeadline(ms: number, where: string, reason?: string): number {
  if (!(ms > 0) || ms > HANG_GUARD_MS) {
    throw new RangeError(`${where}: deadline ${ms} ms is outside 1 to ${HANG_GUARD_MS} ms`);
  }
  if (ms > EVENT_DEADLINE_MS && !reason) {
    throw new RangeError(`${where}: deadline ${ms} ms is over ${EVENT_DEADLINE_MS} ms and needs a reason`);
  }
  return ms;
}

export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** Named in the timeout error so a failure says what never happened. */
  readonly what?: string;
  /** A throw from `check` counts as "not yet", for a store another process holds locked; the last one is named in the timeout error. */
  readonly retryOnThrow?: boolean;
  /** Required when timeoutMs is over EVENT_DEADLINE_MS: why this wait is longer than an event's. */
  readonly reason?: string;
}

/** Polls `check` until it returns true; throws at the deadline so a missed event fails where it was awaited. */
export async function waitFor(check: () => boolean | Promise<boolean>, opts: WaitForOptions = {}): Promise<void> {
  const { timeoutMs = EVENT_DEADLINE_MS, intervalMs = 20, what = 'condition', retryOnThrow = false } = opts;
  checkDeadline(timeoutMs, `waitFor(${what})`, opts.reason);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (await check()) return;
    } catch (err) {
      if (!retryOnThrow) throw err;
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const detail =
        lastError === undefined
          ? ''
          : ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
      throw new Error(`${what} not met within ${timeoutMs} ms${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
