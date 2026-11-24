import { describe, it, expect } from 'vitest';
import { computeVerdict } from '../../benchmarks/sequential-learning/analyze-v1.7.7.mjs';

describe('computeVerdict', () => {
  it('returns SUPPORTED when delta >= 0.10 AND ciLow > 0 AND sanity passes AND tiePass', () => {
    expect(
      computeVerdict({
        c2Late: 0.18,
        c3Late: 0.05,
        delta: 0.13,
        ciLow: 0.04,
        ciHigh: 0.22,
        hookFailures: { push: 0, complete: 0 },
        sanityPass: true,
        tiePass: true,
      }),
    ).toBe('SUPPORTED');
  });

  it('returns NOT_SUPPORTED when delta < 0.10', () => {
    expect(
      computeVerdict({
        c2Late: 0.18,
        c3Late: 0.13,
        delta: 0.05,
        ciLow: 0.01,
        ciHigh: 0.09,
        hookFailures: { push: 0, complete: 0 },
        sanityPass: true,
        tiePass: true,
      }),
    ).toBe('NOT_SUPPORTED');
  });

  it('returns NOT_SUPPORTED when ciLow <= 0 even if delta >= 0.10', () => {
    expect(
      computeVerdict({
        c2Late: 0.18,
        c3Late: 0.05,
        delta: 0.13,
        ciLow: -0.02,
        ciHigh: 0.28,
        hookFailures: { push: 0, complete: 0 },
        sanityPass: true,
        tiePass: true,
      }),
    ).toBe('NOT_SUPPORTED');
  });

  it('returns SANITY_FAIL when sanityPass is false (overrides everything)', () => {
    expect(
      computeVerdict({
        c2Late: 0.0,
        c3Late: 0.0,
        delta: 0.0,
        ciLow: 0.0,
        ciHigh: 0.0,
        hookFailures: { push: 0, complete: 0 },
        sanityPass: false,
        tiePass: true,
      }),
    ).toBe('SANITY_FAIL');
  });

  it('returns HOOK_FAIL when sanity passes but hook failures > 0', () => {
    expect(
      computeVerdict({
        c2Late: 0.18,
        c3Late: 0.05,
        delta: 0.13,
        ciLow: 0.04,
        ciHigh: 0.22,
        hookFailures: { push: 1, complete: 0 },
        sanityPass: true,
        tiePass: true,
      }),
    ).toBe('HOOK_FAIL');
  });

  it('returns NOT_SUPPORTED when tiePass=false even if delta >= 0.10 AND ciLow > 0', () => {
    expect(
      computeVerdict({
        c2Late: 0.18,
        c3Late: 0.05,
        delta: 0.13,
        ciLow: 0.04,
        ciHigh: 0.22,
        hookFailures: { push: 0, complete: 0 },
        sanityPass: true,
        tiePass: false,
      }),
    ).toBe('NOT_SUPPORTED');
  });

  it('precedence: sanityPass=false wins over hook+tie+SUPPORTED-shaped numbers', () => {
    expect(
      computeVerdict({
        c2Late: 0.18,
        c3Late: 0.05,
        delta: 0.13,
        ciLow: 0.04,
        ciHigh: 0.22,
        hookFailures: { push: 1, complete: 0 },
        sanityPass: false,
        tiePass: false,
      }),
    ).toBe('SANITY_FAIL');
  });

  it('precedence: hookFailures wins over tiePass+SUPPORTED-shaped numbers when sanity passes', () => {
    expect(
      computeVerdict({
        c2Late: 0.18,
        c3Late: 0.05,
        delta: 0.13,
        ciLow: 0.04,
        ciHigh: 0.22,
        hookFailures: { push: 0, complete: 1 },
        sanityPass: true,
        tiePass: false,
      }),
    ).toBe('HOOK_FAIL');
  });
});
