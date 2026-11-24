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
