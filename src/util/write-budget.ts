// How long a long-running write may hold the store's write lock per transaction, and how long it lets other writers in after.
import { setTimeout as delay } from 'node:timers/promises';

/** A chunk closes at the first unit boundary after this long: a server request gives up after a 250 ms wait. */
export const TARGET_HOLD_MS = 100;

/** SQLite's longest busy-handler sleep under a hook's 1 s wait, so a waiting hook always wakes inside the gap. */
export const GAP_MS = 100;

export function clock(): number {
  return performance.now();
}

/** Waits until GAP_MS have passed since the last commit; always yields once, so timers and requests run between chunks. */
export async function pauseForWaiters(lastCommitAt: number): Promise<void> {
  await delay(Math.max(0, GAP_MS - (clock() - lastCommitAt)));
}

/** The hold, clock and pause a chunked write runs on; a test passes its own to force chunk boundaries without real waits. */
export interface WriteBudget {
  readonly holdMs: number;
  readonly clock: () => number;
  readonly pause: (lastCommitAt: number) => Promise<void>;
}

export const WRITE_BUDGET: WriteBudget = { holdMs: TARGET_HOLD_MS, clock, pause: pauseForWaiters };
