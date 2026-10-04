import { describe, it, expect } from 'vitest';
import { hitRateByPhase, parseRestrictLateTo } from '../benchmarks/sequential-learning/run.mjs';

// Synthetic 25-trap result fixture. Hit pattern: alternate hit/miss for clarity.
function buildTrapResults(hitPattern: boolean[]): Array<{trapCategory: string|null, trapHit: boolean}> {
  return hitPattern.map((hit, i) => ({ trapCategory: 'cat_' + i, trapHit: hit }));
}

describe('v1.7.7 hitRateByPhase with restrictLateTo', () => {
  it('default (no restrictLateTo) preserves chronological-third behavior', () => {
    // 25 traps: third=9, early=slice(0,9), mid=slice(9,18), late=slice(18) = last 7
    const results = buildTrapResults(Array(25).fill(true));
    const phases = hitRateByPhase(results);
    expect(phases.early).toBe(1.0);
    expect(phases.mid).toBe(1.0);
    expect(phases.late).toBe(1.0);
  });

  it('restrictLateTo=4 puts last 4 traps in late, first 11 in early, middle 10 in mid', () => {
    // Build pattern: first 11 all hit, middle 10 half hit, last 4 none hit.
    const pattern = [
      ...Array(11).fill(true),  // early all hit -> 100%
      ...Array(5).fill(true), ...Array(5).fill(false),  // mid 50%
      ...Array(4).fill(false),  // late all miss -> 0%
    ];
    expect(pattern.length).toBe(25);
    const results = buildTrapResults(pattern);
    const phases = hitRateByPhase(results, 4);
    expect(phases.early).toBe(1.0);
    expect(phases.mid).toBe(0.5);
    expect(phases.late).toBe(0.0);
  });

  it('restrictLateTo=4 with all late traps hit returns late=1.0', () => {
    const pattern = [
      ...Array(11).fill(false),  // early all miss
      ...Array(10).fill(false),  // mid all miss
      ...Array(4).fill(true),    // late all hit
    ];
    const results = buildTrapResults(pattern);
    const phases = hitRateByPhase(results, 4);
    expect(phases.late).toBe(1.0);
    expect(phases.early).toBe(0.0);
    expect(phases.mid).toBe(0.0);
  });

  it('restrictLateTo=0 returns late=0 (empty slice)', () => {
    const results = buildTrapResults(Array(25).fill(true));
    const phases = hitRateByPhase(results, 0);
    expect(phases.late).toBe(0);
  });

  it('restrictLateTo greater than total returns all traps as late', () => {
    const results = buildTrapResults(Array(25).fill(true));
    const phases = hitRateByPhase(results, 30);
    expect(phases.late).toBe(1.0);
    expect(phases.early).toBe(0);  // empty slice
    expect(phases.mid).toBe(0);
  });

  it('parseRestrictLateTo rejects negative integers', () => {
    expect(() => parseRestrictLateTo('-1')).toThrow();
  });

  it('parseRestrictLateTo rejects non-numeric input', () => {
    expect(() => parseRestrictLateTo('abc')).toThrow();
  });

  it('parseRestrictLateTo accepts 0 and positive integers', () => {
    expect(parseRestrictLateTo('0')).toBe(0);
    expect(parseRestrictLateTo('4')).toBe(4);
    expect(parseRestrictLateTo('25')).toBe(25);
  });

  // Post-review P2-1 -- additional boundary coverage
  it('restrictLateTo=1 puts only the last trap in late', () => {
    const pattern = [...Array(24).fill(false), true]; // last one hit
    const results = buildTrapResults(pattern);
    const phases = hitRateByPhase(results, 1);
    expect(phases.late).toBe(1.0);
    // n-N=24 so early=ceil(24/2)=12, mid=12. Both all-miss.
    expect(phases.early).toBe(0.0);
    expect(phases.mid).toBe(0.0);
  });

  it('restrictLateTo=25 puts all traps in late, early/mid empty -> 0', () => {
    const results = buildTrapResults(Array(25).fill(true));
    const phases = hitRateByPhase(results, 25);
    expect(phases.late).toBe(1.0);
    expect(phases.early).toBe(0); // empty slice
    expect(phases.mid).toBe(0);
  });

  it('parseRestrictLateTo rejects floats and signed numbers', () => {
    expect(() => parseRestrictLateTo('4.5')).toThrow();
    expect(() => parseRestrictLateTo('+4')).toThrow();
    expect(() => parseRestrictLateTo('-1.5')).toThrow();
  });
});
