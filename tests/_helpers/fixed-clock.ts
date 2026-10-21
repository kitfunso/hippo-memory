// One shared instant for tests that pass `now` to an API: the clock the code under test reads and the `now` it is given agree.
import { afterEach, beforeEach, vi } from 'vitest';

export const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');

/** Pins Date for each test in the calling file; timers other than Date stay real. */
export function pinClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
