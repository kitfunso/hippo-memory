// The one wall-clock reader: a root builds its Context's clock here, and a store builds the clock its writes stamp by.
import type { Clock } from '../base/ports/infra.js';

/** The wall clock, or a clock fixed at `fakeNowMs` when an eval set one; a number, so it crosses to a worker thread. */
export function hostClock(fakeNowMs: number | null = null): Clock {
  return fakeNowMs === null ? () => new Date() : () => new Date(fakeNowMs);
}
