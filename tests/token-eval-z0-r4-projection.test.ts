// Round 4 prereg item 12 and the plan's Budget model: the spend projection and the one admission check, as pure functions.
import { describe, it, expect } from 'vitest';
import { admissionOk, projectSpend, sequenceGap, stepProjection, wholeRun } from '../scripts/token-eval/z0-budget.mjs';
import { ALL_ARMS, BASIS, BATCH1, MEAN, SEQ, cents, plan, rule, sumsOver } from './_helpers/z0-r4-spend.js';

describe('projectSpend on round 3\'s unrounded bases, as r4-projection.py prints it', () => {
  const gap = sequenceGap(SEQ, BATCH1);
  const batch1 = sumsOver(SEQ, BATCH1);
  const spend = (over: { basisByArm?: Record<string, number>; gapByArm?: Record<string, number>; r?: number; seedsByArm?: Record<string, number>; pilotUsd?: number; scale?: number }) => projectSpend({ basisByArm: BASIS, gapByArm: {}, r: 1, seedsByArm: {}, pilotUsd: 0, scale: 1, ...over });

  it('gives 1284.84, 1714.03 and 2143.22 at r = 1, 1.5 and 2 with the $40 pilot', () => {
    expect([1, 1.5, 2].map((r) => cents(spend({ r, pilotUsd: 40 })))).toEqual(['1284.84', '1714.03', '2143.22']);
  });

  it('gives the 5206.30 ceiling with the four rule arms at 9 seeds at r = 2', () => {
    expect(cents(spend({ r: 2, pilotUsd: 40, seedsByArm: rule(9) }))).toBe('5206.30');
  });

  it('gives batch 1\'s 376.35 and 635.95 from its sequence sums with no gap', () => {
    expect([1, 2].map((r) => cents(spend({ r, basisByArm: batch1 })))).toEqual(['376.35', '635.95']);
  });

  it('gives batch 1 with q145\'s gap 412.82 at r = 1 and 697.03 at r = 2', () => {
    expect([1, 2].map((r) => cents(spend({ r, basisByArm: batch1, gapByArm: gap })))).toEqual(['412.82', '697.03']);
  });

  it('multiplies every projection by the scale and adds the pilot once, unscaled', () => {
    const unscaled = spend({ r: 1.5, gapByArm: gap, seedsByArm: rule(5) });
    expect(spend({ r: 1.5, gapByArm: gap, seedsByArm: rule(5), scale: 1.2 })).toBeCloseTo(1.2 * unscaled, 9);
    expect(spend({ r: 1.5, gapByArm: gap, seedsByArm: rule(5), scale: 1.2, pilotUsd: 40 })).toBeCloseTo(1.2 * unscaled + 40, 9);
  });

  it('runs S0 and S4 at their own 2 seeds, and a seed count of 0 projects nothing for that arm', () => {
    const none = { O1: 0, S0: 0, S1: 0, S2: 0, S4: 0, S5: 0 };
    expect(spend({ seedsByArm: none })).toBe(0);
    expect(spend({ seedsByArm: { ...none, S0: 2 } })).toBeCloseTo(0.5 * BASIS.A0, 9);
    expect(spend({ seedsByArm: { ...none, O1: 3 } })).toBeCloseTo(BASIS.A1, 9);
  });

  it('refuses a basis that holds no spend for an arm\'s twin, naming the twin', () => {
    const { A4: dropped, ...without } = BASIS;
    expect(dropped).toBeGreaterThan(0);
    expect(() => spend({ basisByArm: without })).toThrow(/no spend for A4/);
  });

  it('gives the q145 gaps A0 8.68, A1 11.86, A2 11.49, A4 6.65 and A5 10.57', () => {
    expect(Object.fromEntries(Object.entries(gap).map(([a, x]) => [a, cents(x)]))).toEqual({ A0: '8.68', A1: '11.86', A2: '11.49', A4: '6.65', A5: '10.57' });
  });

  it('refuses a gap that cannot be taken: q145 missing from the keys or from the sequences, or a key with no row', () => {
    expect(() => sequenceGap(SEQ, BATCH1.filter((q) => q !== 'q145'))).toThrow(/do not hold q145/);
    const { q145: dropped, ...without } = SEQ;
    expect(dropped.A0).toBeGreaterThan(0);
    expect(() => sequenceGap(without, BATCH1)).toThrow(/no row for q145/);
    expect(() => sequenceGap(SEQ, [...BATCH1, 'q999'])).toThrow(/no row for q999/);
  });

  it('gives the whole-run check 1641.64 and 2464.81 at r = 1 and 2745.38 and 4059.80 at r = 2, for 3 and 5 seeds, with the pilot and the 1.25 margin', () => {
    const need = (r: number, seeds: number) => cents(40 + 1.25 * wholeRun({ basisByArm: BASIS, gapByArm: gap, r, seeds }));
    expect([need(1, 3), need(1, 5), need(2, 3), need(2, 5)]).toEqual(['1641.64', '2464.81', '2745.38', '4059.80']);
  });
});
describe('step projections at the measured mean per record', () => {
  it('projects the smoke, 6 sessions and 2 warm-ups, at $2.76', () => {
    expect(cents(stepProjection({ plans: [plan(6, ALL_ARMS)], meanPerRecord: MEAN, warmupUsd: undefined }))).toBe('2.76');
  });

  it('projects the pilot, 108 sessions and 4 effort sessions, at $38.64 before its 8 warm-ups', () => {
    const plans = [plan(54, ['O1', 'S1', 'S2']), plan(54, ['O1', 'S1', 'S2']), plan(2, ['O1', 'S1']), plan(2, ['O1', 'S1'])];
    expect(cents(stepProjection({ plans, meanPerRecord: MEAN, warmupUsd: 0 }))).toBe('38.64');
    expect(stepProjection({ plans, meanPerRecord: MEAN, warmupUsd: 0.17 })).toBeCloseTo(112 * MEAN + 8 * 0.17, 9);
    expect(stepProjection({ plans, meanPerRecord: MEAN, warmupUsd: 0.17 })).toBeLessThan(40);
  });

  it('projects 118 sessions, 2 more positions in one pilot repository, at $40.71', () => {
    const plans = [plan(60, ['O1', 'S1', 'S2']), plan(54, ['O1', 'S1', 'S2']), plan(2, ['O1', 'S1']), plan(2, ['O1', 'S1'])];
    expect(cents(stepProjection({ plans, meanPerRecord: MEAN, warmupUsd: 0 }))).toBe('40.71');
  });

  it('counts one warm-up per distinct model of each plan\'s Claude Code arms, and prices it at the mean when there is no measured cost', () => {
    expect(stepProjection({ plans: [plan(4, ['S1', 'S2'])], meanPerRecord: 1, warmupUsd: 5 })).toBe(9);
    expect(stepProjection({ plans: [plan(4, ['O1', 'S1'])], meanPerRecord: 1, warmupUsd: 5 })).toBe(14);
    expect(stepProjection({ plans: [plan(4, ['O1', 'S1'])], meanPerRecord: 1, warmupUsd: undefined })).toBe(6);
  });
});

describe('admissionOk, the one check', () => {
  const ok = (over: { ledger?: number; projection?: number; margin?: number; figure?: number | null; cap?: number | null; capSpend?: number }) => admissionOk({ ledger: 1000, projection: 30, margin: 1.25, figure: 1100, cap: null, capSpend: 0, ...over });

  it('is true only when ledger + margin x projection is at most the figure', () => {
    expect([ok({ figure: 1037.5 }), ok({ figure: 1037.49 })]).toEqual([true, false]);
  });

  it('reads the margin on the projection alone: a case that fits ledger + 1.25 x projection and misses 1.25 x (ledger + projection)', () => {
    const fits = { ledger: 1000, projection: 100, figure: 1130 };
    expect(fits.ledger + 1.25 * fits.projection).toBeLessThanOrEqual(fits.figure);
    expect(1.25 * (fits.ledger + fits.projection)).toBeGreaterThan(fits.figure);
    expect(ok(fits)).toBe(true);
  });

  it('with ledger 1000, projection 30 and figure 1035 passes at margin 1 and refuses at 1.25 (1037.50)', () => {
    expect([ok({ figure: 1035, margin: 1 }), ok({ figure: 1035, margin: 1.25 })]).toEqual([true, false]);
  });

  it('tests the cap on capSpend + projection where the step has one, and skips the figure in a cap-only check', () => {
    expect([ok({ margin: 1, cap: 40 }), ok({ margin: 1, cap: 29.99 })]).toEqual([true, false]);
    expect(ok({ margin: 1, cap: 40, capSpend: 11 })).toBe(false);
    expect(ok({ margin: 1, cap: 40, capSpend: 10 })).toBe(true);
    expect(ok({ figure: null, margin: 1, cap: 40, capSpend: 9 })).toBe(true);
    expect(ok({ ledger: 5000, figure: null, margin: 1, cap: 40, capSpend: 11 })).toBe(false);
  });
});
