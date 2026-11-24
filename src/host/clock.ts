import type { Clock } from '../base/ports/infra.js';

/** The wall clock, or a clock fixed at `fakeNowMs` when an eval set one; a number, so it crosses
 * to a worker thread. */
export function hostClock(fakeNowMs: number | null = null): Clock {
  return fakeNowMs === null ? () => new Date() : () => new Date(fakeNowMs);
}
