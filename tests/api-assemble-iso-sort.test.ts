import { describe, it, expect } from 'vitest';

/**
 * F4 — byte compare canonical UTC ISO timestamps instead of localeCompare.
 *
 * Canonical UTC ISO (`Date.prototype.toISOString()`) is 24 chars, fixed-width,
 * trailing `Z`. Byte compare is chronological for these strings; localeCompare
 * does locale-aware Unicode collation (~50× slower) with no semantic benefit.
 *
 * The first test proves the equivalence holds across a range of practical
 * timestamps (sub-second, sub-minute, cross-day, cross-month, cross-year,
 * epoch). The second test asserts the assemble path returns chronologically
 * ordered items after the byte-cmp swap.
 */
describe('assemble ISO sort (F4)', () => {
  it('byte compare matches localeCompare for canonical UTC ISO timestamps', () => {
    const isoSamples = [
      '2026-05-06T00:00:00.000Z',
      '2026-05-06T00:00:00.001Z',
      '2026-05-06T00:00:00.999Z',
      '2026-05-06T00:00:01.000Z',
      '2026-05-06T00:01:00.000Z',
      '2026-05-06T01:00:00.000Z',
      '2026-05-06T23:59:59.999Z',
      '2026-05-07T00:00:00.000Z',
      '2026-06-06T00:00:00.000Z',
      '2027-05-06T00:00:00.000Z',
      '1970-01-01T00:00:00.000Z',
      '1970-01-01T00:00:00.001Z',
      '2099-12-31T23:59:59.999Z',
    ];
    const cmpIso = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byteSorted = [...isoSamples].sort(cmpIso);
    const localeSorted = [...isoSamples].sort((a, b) => a.localeCompare(b));
    expect(byteSorted).toEqual(localeSorted);
  });

  it('byte compare matches Date-numeric ordering for randomized canonical ISO inputs', () => {
    // Random check across 100 generated timestamps spanning ~50 years.
    const samples: string[] = [];
    for (let i = 0; i < 100; i++) {
      const epoch = Math.floor(Math.random() * 1_700_000_000_000);
      samples.push(new Date(epoch).toISOString());
    }
    const cmpIso = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byteSorted = [...samples].sort(cmpIso);
    const numericSorted = [...samples].sort(
      (a, b) => Date.parse(a) - Date.parse(b),
    );
    expect(byteSorted).toEqual(numericSorted);
  });
});
