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
  const { timeoutMs = 10_000, intervalMs = 20, what = 'condition', retryOnThrow = false } = opts;
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
      const detail = lastError === undefined ? '' : ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
      throw new Error(`${what} not met within ${timeoutMs} ms${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
