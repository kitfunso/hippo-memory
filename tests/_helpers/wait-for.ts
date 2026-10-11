export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** Named in the timeout error so a failure says what never happened. */
  readonly what?: string;
}

/** Polls `check` until it returns true; throws at the deadline so a missed event fails where it was awaited. */
export async function waitFor(check: () => boolean | Promise<boolean>, opts: WaitForOptions = {}): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 20, what = 'condition' } = opts;
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`${what} not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
