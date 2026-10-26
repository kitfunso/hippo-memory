// The watchdog the hostile-input tests rely on is live: it passes a linear scan and stops a quadratic one.
import { describe, expect, it } from 'vitest';
import { fillTo, ONE_MIB, scanWithinWatchdog, WATCHDOG_MS } from '../_helpers/scan-watchdog.js';

describe('scanWithinWatchdog', () => {
  it('returns what a linear scan returns for a 1 MiB input', () => {
    expect(scanWithinWatchdog((text) => text.replaceAll('a', 'b').length, fillTo('a', ONE_MIB), WATCHDOG_MS)).toBe(
      ONE_MIB,
    );
  });

  it('stops a quadratic scan at the deadline and names the deadline', () => {
    // A run of spaces ending in a non-space makes /\s+$/ retry from every space, which is quadratic.
    const hostile = `${fillTo(' ', ONE_MIB)}x`;
    expect(() => scanWithinWatchdog((text) => /\s+$/.test(text), hostile, 200)).toThrow(
      /did not finish within 200 ms: a pattern is super-linear/,
    );
  });

  it('passes an error the scan itself throws through unchanged', () => {
    const failing = (): never => {
      throw new RangeError('the scan failed');
    };
    expect(() => scanWithinWatchdog(failing, 'x', WATCHDOG_MS)).toThrow(RangeError);
  });
});
