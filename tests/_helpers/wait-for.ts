/** The default deadline of an awaited event: a test's own wait never runs past it unless it names why. */
export const EVENT_DEADLINE_MS = 10_000;
/** The longest any wait or child run may take, so it fails before vitest's 60 s worker RPC timeout does. */
export const HANG_GUARD_MS = 45_000;

export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** Named in the timeout error so a failure says what never happened. */
  readonly what?: string;
  /** A throw from `check` counts as "not yet", for a store another process holds locked; the last one is named in the timeout error. */
  readonly retryOnThrow?: boolean;
}

/** Polls `check` until it returns true; throws at the deadline so a missed event fails where it was awaited. */
export async function waitFor(check: () => boolean | Promise<boolean>, opts: WaitForOptions = {}): Promise<void> {
  const { timeoutMs = EVENT_DEADLINE_MS, intervalMs = 20, what = 'condition', retryOnThrow = false } = opts;
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
