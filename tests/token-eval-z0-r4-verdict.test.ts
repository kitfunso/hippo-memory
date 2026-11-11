// Round 4 prereg items 2 and 12 (stage rows "Verdict rule" and the shared scorer): scoreTest, the closed test, t2P and minLevels.
import { describe, it, expect } from 'vitest';
import { holmAdjust, verdict } from '../dist/eval/eval-stats.js';
import { fixedRepositoryT, incompleteBeta, studentTQuantile } from '../dist/eval/repository-t.js';
import { firstApplyR, repeatMistakeUnits, SPECS } from '../scripts/token-eval/z0-hypotheses.mjs';
import { parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { NO_VERDICT, T_NULLS, closedTest, minLevels, scoreTest, t2P } from '../scripts/token-eval/z0-verdict-r4.mjs';
import { generate, jsonl, type Knobs } from './fixtures/z0-gen.js';

type Side = 'below' | 'above';
const spec = (nullValue: number, side: Side, level: number) => ({ nullValue, side, level });

describe('scoreTest on slice 1\'s round 3 corpus', () => {
  const corpus = (knobs: Partial<Record<string, Knobs>>) => parseZ0Records(jsonl(generate({ knobs }).records), 'runs.jsonl').records;

  it('gives fixedRepositoryT\'s p to 1e-12 at null 0 and its 95% bounds to 1e-9 at level 0.05', () => {
    for (const knobs of [{ A2: { fail: 0.2 }, A1: { fail: 0.5 } }, { A2: { fail: 0.6 }, A1: { fail: 0.4 }, A0: { fail: 0.9 } }, { A2: { fail: 0.45 }, A1: { fail: 0.5 } }]) {
      const t = fixedRepositoryT(repeatMistakeUnits(corpus(knobs), 'A2', 'A1', 'violation', firstApplyR).units, 0);
      const s = scoreTest({ estimate: t.estimate, se: t.se!, df: t.df! }, spec(0, 'below', 0.05));
      expect(Math.abs(s.p - t.p)).toBeLessThan(1e-12);
      expect(s.low).toBeCloseTo(t.low, 9);
      expect(s.high).toBeCloseTo(t.high, 9);
    }
  });

  it('follows tResult when the table has no spread: p is 1 on the null and 0 off it', () => {
    const flat = (value: number) => ['f1', 'f2', 'f3'].flatMap((family) => [1, 2].flatMap((seed) => ['r1', 'r2'].map((repo) => ({ repo, family, seed, value }))));
    for (const value of [0, 0.2]) {
      const t = fixedRepositoryT(flat(value), 0);
      const s = scoreTest({ estimate: t.estimate, se: t.se!, df: t.df! }, spec(0, 'above', 0.05));
      expect([s.p, s.low, s.high]).toEqual([t.p, t.low, t.high]);
    }
  });

  it('gives no p, no bounds and no win for a non-finite estimate or standard error', () => {
    const s = scoreTest({ estimate: Number.NaN, se: 0.1, df: 5 }, spec(0, 'below', 0.05));
    expect(s).toEqual({ p: Number.NaN, low: Number.NaN, high: Number.NaN, win: false, edge: false });
  });
});

describe('scoreTest at a fractional df', () => {
  const [estimate, se, df] = [-1.3, 0.5, 7.3456];
  const z = estimate / se;

  it('takes p from the raw df, as twoSidedTail does, exactly', () => {
    expect(scoreTest({ estimate, se, df }, spec(0, 'below', 0.05)).p).toBe(incompleteBeta(df / (df + z * z), df / 2, 0.5));
  });

  it('takes the bounds from df rounded to 3 decimals: the 97.5% quantile at 0.05 and the 98.75% one, wider, at 0.025', () => {
    const [a, b] = [scoreTest({ estimate, se, df }, spec(0, 'below', 0.05)), scoreTest({ estimate, se, df }, spec(0, 'below', 0.025))];
    expect(a.low).toBeCloseTo(estimate - studentTQuantile(0.975, 7.346) * se, 12);
    expect(a.high).toBeCloseTo(estimate + studentTQuantile(0.975, 7.346) * se, 12);
    expect(Math.abs(a.high - (estimate + studentTQuantile(0.975, df) * se))).toBeGreaterThan(1e-7);
    expect(b.low).toBeCloseTo(estimate - studentTQuantile(0.9875, 7.346) * se, 12);
    expect(b.high - b.low).toBeGreaterThan(a.high - a.low);
  });
});

describe('scoreTest nulls, sides and the win', () => {
  it('holds the nulls and sides in one constant', () => {
    expect(T_NULLS).toEqual({
      T1: { nullValue: 0, side: 'below' }, T3: { nullValue: 0, side: 'below' }, T2a: { nullValue: 0, side: 'below' },
      T2b: { nullValue: -0.03, side: 'above' }, T2c: { nullValue: 0.15, side: 'below' },
    });
  });

  it('gives p = 1 at an estimate on the null of T2b and of T2c', () => {
    expect(scoreTest({ estimate: -0.03, se: 0.02, df: 9 }, { ...T_NULLS.T2b, level: 0.05 }).p).toBe(1);
    expect(scoreTest({ estimate: 0.15, se: 0.02, df: 9 }, { ...T_NULLS.T2c, level: 0.05 }).p).toBe(1);
  });

  it('never wins on the wrong side, however small p is', () => {
    for (const level of [0.025, 0.05]) {
      const [below, above] = [scoreTest({ estimate: 0.9, se: 0.01, df: 12 }, spec(0, 'below', level)), scoreTest({ estimate: -0.9, se: 0.01, df: 12 }, spec(0, 'above', level))];
      expect([below.p < 1e-9, below.win, above.p < 1e-9, above.win]).toEqual([true, false, true, false]);
    }
  });

  /** The estimate at which scoreTest's p crosses `level`, found by bisection on a unit standard error. */
  const crossing = (df: number, level: number): number => {
    let [lo, hi] = [0, 10];
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (scoreTest({ estimate: mid, se: 1, df }, spec(0, 'above', level)).p < level) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  it('compares strictly: a p equal to the level is no win', () => {
    const at = scoreTest({ estimate: -1.3, se: 0.5, df: 9 }, spec(0, 'below', 0.05));
    expect(scoreTest({ estimate: -1.3, se: 0.5, df: 9 }, spec(0, 'below', at.p)).win).toBe(false);
    expect(scoreTest({ estimate: -1.3, se: 0.5, df: 9 }, spec(0, 'below', at.p + 1e-12)).win).toBe(true);
  });

  it('wins at a p 1e-4 under each level, with the interval at that level past the null on that side', () => {
    for (const level of [0.025, 0.05]) {
      let [lo, hi] = [0, 10];
      for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (scoreTest({ estimate: mid, se: 1, df: 12.5 }, spec(0, 'above', level)).p < level - 1e-4) hi = mid;
        else lo = mid;
      }
      const up = scoreTest({ estimate: hi, se: 1, df: 12.5 }, spec(0, 'above', level));
      const down = scoreTest({ estimate: -hi, se: 1, df: 12.5 }, spec(0, 'below', level));
      expect([up.win, up.low > 0, up.edge, down.win, down.high < 0, down.edge]).toEqual([true, true, false, true, true, false]);
      expect(level - up.p).toBeCloseTo(1e-4, 8);
    }
  });

  it('flags a knife edge where the rounded df moves a bound across the null and win follows p (df rounds down)', () => {
    const [raw, rounded] = [crossing(7.3454, 0.05), studentTQuantile(0.975, 7.345)];
    expect(rounded).toBeGreaterThan(raw);
    const s = scoreTest({ estimate: (raw + rounded) / 2, se: 1, df: 7.3454 }, spec(0, 'above', 0.05));
    expect([s.p < 0.05, s.win, s.low > 0, s.edge]).toEqual([true, true, false, true]);
  });

  it('flags the opposite edge where p is above the level and the bound is already past the null (df rounds up)', () => {
    const [raw, rounded] = [crossing(7.3456, 0.05), studentTQuantile(0.975, 7.346)];
    expect(rounded).toBeLessThan(raw);
    const s = scoreTest({ estimate: (raw + rounded) / 2, se: 1, df: 7.3456 }, spec(0, 'above', 0.05));
    expect([s.p < 0.05, s.win, s.low > 0, s.edge]).toEqual([false, false, true, true]);
  });
});

/* ------------------------------------------------------------------------------------------------ the closed test */

interface Bound { low: number; high: number }
interface View { p: number; estimate: number; side: Side; bounds: { '0.025': Bound; '0.05': Bound } }
const view = (p: number, estimate: number, side: Side = 'below', half = 0.05): View => ({
  p, estimate, side, bounds: { '0.025': { low: estimate - 1.2 * half, high: estimate + 1.2 * half }, '0.05': { low: estimate - half, high: estimate + half } },
});
const codings = (violation: View, excluded: View) => ({ codings: { violation, excluded } });
const NOMINAL = { T1: { '0.05': 0.05 }, T3: { '0.025': 0.025, '0.05': 0.05 }, T2a: { '0.025': 0.025, '0.05': 0.05 }, T2b: { '0.025': 0.025, '0.05': 0.05 }, T2c: { '0.025': 0.025, '0.05': 0.05 } };
// Helpful estimates for each test: T1, T3 and T2a below their null, T2b above its null, T2c below its.
const winT1 = (p = 0.001): View => view(p, -0.3);
const winA = (p = 0.001): View => view(p, -0.2);
const winB = (p = 0.001): View => view(p, 0, 'above');
const winC = (p = 0.001): View => view(p, 0);
const winT3 = (p = 0.001): View => view(p, -0.3);
interface Input { T1: View | ReturnType<typeof codings> | null; T2: { a: View | null; b: View | null; c: View | ReturnType<typeof codings> | null } | null; T3: View | ReturnType<typeof codings> | null }
const base = (over: Partial<Input> = {}): Input => ({ T1: winT1(), T2: { a: winA(), b: winB(), c: winC() }, T3: winT3(), ...over });
const run = (input: Input, levels = NOMINAL) => closedTest(input, levels);
type Closed = ReturnType<typeof run>;
// A result with no verdict carries a reason only, so the fields below are read through these narrowing helpers.
const t1Of = (r: Closed) => {
  if (!('reachesMinimum' in r.T1)) throw new Error(`T1 is ${r.T1.verdict}: no reachesMinimum`);
  return r.T1;
};
const t2Of = (r: Closed) => {
  if (!('parts' in r.T2)) throw new Error(`T2 is ${r.T2.verdict}: no parts`);
  return r.T2;
};
const tested = (estimate: number, low: number, high: number, p: number) => ({ estimate, low, high, nullValue: 0, p, dropped: 0, iterations: 0 });

describe('the T1 gate', () => {
  it('reads T1 alone at its level at 0.05', () => {
    expect(run(base({ T1: winT1(0.049) })).T1.verdict).toBe('win');
    expect(run(base({ T1: winT1(0.049) }), { ...NOMINAL, T1: { '0.05': 0.03 } }).T1.verdict).not.toBe('win');
  });

  it('gives T2 and T3 no verdict when T1 does not win, whatever their own p', () => {
    for (const T1 of [view(0.5, -0.05, 'below', 0.2), view(0.5, -0.01, 'below', 0.05), view(0.001, 0.3), null]) {
      const r = run(base({ T1 }));
      expect([r.T2.verdict, r.T3.verdict, r.jointFalls]).toEqual([NO_VERDICT, NO_VERDICT, false]);
    }
  });

  it('reports a T1 loss as a loss, and still gives T2 and T3 none', () => {
    const r = run(base({ T1: view(0.001, 0.3) }));
    expect([r.T1.verdict, r.T2.verdict, r.T3.verdict]).toEqual(['loss', NO_VERDICT, NO_VERDICT]);
  });

  it('gives T1 no verdict for a null test', () => {
    expect(run(base({ T1: null })).T1.verdict).toBe(NO_VERDICT);
  });
});

describe('every comparison is strict', () => {
  it('gives no T1 win at p equal to its level, no joint null at p equal to 0.025, and no T2 pass at p equal to 0.05', () => {
    expect(run(base({ T1: winT1(0.05) })).T1.verdict).not.toBe('win');
    const none = { a: winA(0.3), b: winB(0.3), c: winC(0.3) };
    expect(run(base({ T3: winT3(0.025), T2: none })).jointFalls).toBe(false);
    expect(run(base({ T3: winT3(0.0249999), T2: none })).jointFalls).toBe(true);
    expect(run(base({ T2: { a: winA(0.05), b: winB(), c: winC() }, T3: winT3(0.001) })).T2.verdict).toBe('no pass');
  });

  it('reads the tie band and the minimum as round 3 does: inclusive at -0.15 and 0.15', () => {
    const edge = view(0.5, 0, 'below', 0.15);
    expect(run(base({ T1: edge })).T1.verdict).toBe('tie');
    expect(t1Of(run(base({ T1: view(0.001, -0.15) }))).reachesMinimum).toBe(true);
  });
});

describe('labels: tie, inconclusive and the minimum, under each coding', () => {
  const read = (bounds: number, estimate = 0, p = 0.5) => view(p, estimate, 'below', bounds);

  it('reads a zero estimate with bounds of -0.05 to 0.05 as a tie and -0.25 to 0.25 as inconclusive, for T1 and for T3 after a T1 win', () => {
    expect(run(base({ T1: codings(read(0.05), read(0.05)) })).T1.verdict).toBe('tie');
    expect(run(base({ T1: codings(read(0.25), read(0.25)) })).T1.verdict).toBe('inconclusive');
    expect(run(base({ T3: codings(read(0.05), read(0.05)) })).T3.verdict).toBe('tie');
    expect(run(base({ T3: codings(read(0.25), read(0.25)) })).T3.verdict).toBe('inconclusive');
  });

  it('reads a tie under one coding and inconclusive under the other as inconclusive', () => {
    expect(run(base({ T1: codings(read(0.05), read(0.25)) })).T1.verdict).toBe('inconclusive');
    expect(run(base({ T3: codings(read(0.25), read(0.05)) })).T3.verdict).toBe('inconclusive');
  });

  it('reaches the minimum on a T1 win at -0.20 under both codings, and not at -0.10', () => {
    const win = (estimate: number) => t1Of(run(base({ T1: codings(view(0.001, estimate), view(0.002, estimate)) })));
    expect([win(-0.2).verdict, win(-0.2).reachesMinimum]).toEqual(['win', true]);
    expect([win(-0.1).verdict, win(-0.1).reachesMinimum]).toEqual(['win', false]);
    expect(t1Of(run(base({ T1: codings(view(0.001, -0.2), view(0.002, -0.1)) }))).reachesMinimum).toBe(false);
  });

  it('needs both codings to win: a win under one and a tie under the other is inconclusive, and a loss under either is a loss', () => {
    expect(run(base({ T1: codings(winT1(), read(0.05)) })).T1.verdict).toBe('inconclusive');
    expect(run(base({ T1: codings(winT1(), view(0.001, 0.3)) })).T1.verdict).toBe('loss');
  });

  it('matches round 3\'s verdict on the same p, estimate and bounds', () => {
    for (const [p, estimate, half] of [[0.03, -0.2, 0.05], [0.2, -0.04, 0.05], [0.2, -0.04, 0.3], [0.01, 0.2, 0.05]] as const) {
      const v = view(p, estimate, 'below', half);
      const want = verdict(tested(estimate, v.bounds['0.05'].low, v.bounds['0.05'].high, p), p, SPECS.H1);
      expect(run(base({ T1: v })).T1).toMatchObject({ verdict: want.verdict, reachesMinimum: want.reachesMinimum });
    }
  });
});

describe('the joint null of T2 and T3', () => {
  it('falls when T3 wins at its level at 0.025, and T3 then wins at 0.05', () => {
    const r = run(base({ T3: winT3(0.02), T2: { a: winA(0.3), b: winB(0.3), c: winC(0.3) } }));
    expect([r.jointFalls, r.T3.verdict, r.T2.verdict]).toEqual([true, 'win', 'no pass']);
  });

  it('does not fall on a T3 win at 0.05 only, so T3 has no win', () => {
    const r = run(base({ T3: winT3(0.04), T2: { a: winA(0.3), b: winB(0.3), c: winC(0.3) } }));
    expect([r.jointFalls, r.T3.verdict]).toEqual([false, 'inconclusive']);
  });

  it('falls on a T2 pass at 0.025, which lets T3 win at 0.05', () => {
    const r = run(base({ T3: winT3(0.04) }));
    expect([r.jointFalls, r.T2.verdict, r.T3.verdict]).toEqual([true, 'pass', 'win']);
  });

  it('passes a part at 0.03 only once the joint null has fallen another way', () => {
    const parts = { a: winA(0.03), b: winB(), c: winC() };
    expect(run(base({ T2: parts, T3: winT3(0.3) })).T2.verdict).toBe('no pass');
    expect(run(base({ T2: parts, T3: winT3(0.01) })).T2.verdict).toBe('pass');
  });

  it('sets a T3 win at a lowered level at 0.025 that opens it, and no win just above that level', () => {
    const levels = { ...NOMINAL, T3: { '0.025': 0.02, '0.05': 0.05 } };
    const none = { a: winA(0.3), b: winB(0.3), c: winC(0.3) };
    expect(run(base({ T3: winT3(0.019), T2: none }), levels).jointFalls).toBe(true);
    expect(run(base({ T3: winT3(0.021), T2: none }), levels).jointFalls).toBe(false);
  });

  it('does not open on a T3 win under one coding only', () => {
    const none = { a: winA(0.3), b: winB(0.3), c: winC(0.3) };
    const r = run(base({ T3: codings(winT3(0.001), view(0.04, -0.3)), T2: none }));
    expect([r.jointFalls, r.T3.verdict]).toEqual([false, 'inconclusive']);
    expect(run(base({ T3: codings(winT3(0.001), winT3(0.002)), T2: none })).jointFalls).toBe(true);
  });

  it('reports a T3 loss below its level at 0.025 and leaves the joint null standing', () => {
    const r = run(base({ T3: view(0.01, 0.3), T2: { a: winA(0.03), b: winB(0.03), c: winC(0.03) } }));
    expect([r.T3.verdict, r.jointFalls, r.T2.verdict]).toEqual(['loss', false, 'no pass']);
  });

  it('reports a T3 loss at its level at 0.05 only once the joint null has fallen, at a lowered level', () => {
    const levels = { ...NOMINAL, T3: { '0.025': 0.025, '0.05': 0.04 } };
    const lossAt = (p: number, T2: Input['T2']) => run(base({ T3: view(p, 0.3), T2 }), levels);
    expect(lossAt(0.039, { a: winA(), b: winB(), c: winC() }).T3.verdict).toBe('loss');
    expect(lossAt(0.041, { a: winA(), b: winB(), c: winC() }).T3.verdict).not.toBe('loss');
    expect(lossAt(0.039, { a: winA(0.3), b: winB(0.3), c: winC(0.3) }).T3.verdict).not.toBe('loss');
  });

  it('enters a test with no verdict at p = 1, so the other test must win at 0.025 itself', () => {
    const r = run(base({ T3: null }));
    expect([r.T3.verdict, r.jointFalls, r.T2.verdict]).toEqual([NO_VERDICT, true, 'pass']);
    const none = run(base({ T3: null, T2: { a: winA(0.04), b: winB(), c: winC() } }));
    expect([none.jointFalls, none.T2.verdict]).toEqual([false, 'no pass']);
  });
});

describe('T2 as pass or no pass', () => {
  it('needs all three parts, each at its own level', () => {
    for (const miss of ['a', 'b', 'c'] as const) {
      const parts = { a: winA(), b: winB(), c: winC(), [miss]: view(0.2, 0, miss === 'b' ? 'above' : 'below', 0.5) };
      expect(run(base({ T2: parts })).T2.verdict).toBe('no pass');
    }
    expect(run(base()).T2.verdict).toBe('pass');
  });

  it('needs part (c) under both codings, and reports no loss for it', () => {
    const both = base({ T2: { a: winA(), b: winB(), c: codings(winC(), winC(0.002)) } });
    expect(run(both).T2.verdict).toBe('pass');
    const one = run(base({ T2: { a: winA(), b: winB(), c: codings(winC(), view(0.04, 0.3, 'below', 0.01)) } }));
    expect(one.T2.verdict).toBe('no pass');
    expect(JSON.stringify(one.T2)).not.toContain('loss');
  });

  it('prints a part whose whole interval lies on the harmful side with no verdict, and never calls it a loss', () => {
    const r = run(base({ T2: { a: view(0.001, 0.4, 'below', 0.05), b: winB(), c: winC() } }));
    expect(r.T2.verdict).toBe('no pass');
    expect(t2Of(r).parts.a.harmfulSide).toBe(true);
    expect([t2Of(r).parts.b.harmfulSide, t2Of(r).parts.c.harmfulSide]).toEqual([false, false]);
    const c = run(base({ T2: { a: winA(), b: winB(), c: codings(winC(), view(0.001, 0.4, 'below', 0.05)) } }));
    expect(t2Of(c).parts.c.harmfulSide).toBe(true);
  });

  it('is no pass when a part has no estimate', () => {
    const r = run(base({ T2: { a: null, b: winB(), c: winC() } }));
    expect([r.T2.verdict, t2Of(r).p]).toEqual(['no pass', 1]);
  });

  it('gives T2 no pass when part (a) has no estimate because a side has 0 solves', () => {
    expect(run(base({ T2: { a: null, b: winB(), c: winC() }, T3: winT3(0.3) })).T2.verdict).toBe('no pass');
  });
});

describe('closed testing equals Holm at 0.05 when no level is lowered and no loss occurs', () => {
  const grid = [0.0005, 0.004, 0.0125, 0.0249, 0.026, 0.03, 0.049, 0.051, 0.2, 0.9];

  it('gives the same wins for T2 and T3 as holmAdjust and verdict on the same p values', () => {
    for (const p2 of grid) {
      for (const p3 of grid) {
        const r = run(base({ T2: { a: winA(p2), b: winB(p2), c: winC(p2) }, T3: view(p3, -0.3) }));
        const adjusted = holmAdjust([p2, p3]);
        const [h2, h3] = [verdict(tested(-0.3, -0.4, -0.2, adjusted[0]!), adjusted[0]!, SPECS.H1), verdict(tested(-0.3, -0.4, -0.2, adjusted[1]!), adjusted[1]!, SPECS.H1)];
        expect([r.T2.verdict === 'pass', r.T3.verdict === 'win'], `${p2} ${p3}`).toEqual([h2.verdict === 'win', h3.verdict === 'win']);
      }
    }
  });
});

describe('t2P', () => {
  const parts = (a: View | null, b: View | null, c: View | ReturnType<typeof codings> | null) => ({ a, b, c });

  it('is the largest one-sided part p, both codings for part (c), doubled', () => {
    // One-sided p of each part: a 0.01, b 0.005, c 0.015 and 0.02, so the largest is 0.02 and t2P is 0.04.
    expect(t2P(parts(winA(0.02), winB(0.01), codings(winC(0.03), winC(0.04))))).toBeCloseTo(0.04, 14);
  });

  it('puts a part on the harmful side at one minus its one-sided p, which caps at 1', () => {
    expect(t2P(parts(view(0.02, 0.2), winB(0.01), winC(0.01)))).toBe(1);
  });

  it('enters a part with no estimate at p = 1', () => {
    expect(t2P(parts(null, winB(0.01), winC(0.01)))).toBe(1);
  });

  it('decides nothing: a verdict reads each part at its own level, whatever t2P says', () => {
    const lowered = { ...NOMINAL, T2a: { '0.025': 0.025, '0.05': 0.02 } };
    const input = base({ T2: { a: winA(0.03), b: winB(0.01), c: winC(0.01) }, T3: winT3(0.01) });
    const [r, nominal] = [run(input, lowered), run(input, NOMINAL)];
    expect([t2Of(r).p, t2Of(nominal).p]).toEqual([t2P(input.T2!), t2P(input.T2!)]);
    expect(t2Of(r).p).toBeLessThan(0.05);
    expect([r.T2.verdict, nominal.T2.verdict]).toEqual(['no pass', 'pass']);
  });
});

describe('inputs closedTest refuses', () => {
  it('names the level that is missing', () => {
    expect(() => closedTest(base(), { ...NOMINAL, T3: { '0.05': 0.05 } })).toThrow(/levels\.T3\['0\.025'\]/);
  });
});

/* ------------------------------------------------------------------------------------------------ minLevels */

interface Entry { level: number; setBy: string; cells: { setting: string; size: number; simError: number }[] }
interface LevelsFile { schema: string; source: string; draws: number; commit: string; sources: { file: string; sha256: string }[]; floorFlags: string[]; levels: { T1?: { '0.05': Entry }; T3?: Both; T2a?: Both; T2b?: Partial<Both>; T2c?: Both } }
interface Both { '0.025': Entry; '0.05': Entry }
const entry = (level: number, setBy = 'rule at bounds'): Entry => ({ level, setBy, cells: [{ setting: 'other', size: 0.01, simError: 0.001 }, { setting: setBy, size: 0.02, simError: 0.001 }] });
const MODULES = [{ file: 'scripts/token-eval/z0-size-sim.mjs', sha256: 'aa' }, { file: 'scripts/token-eval/z0-cost-solved.mjs', sha256: 'bb' }, { file: 'scripts/token-eval/z0-verdict-r4.mjs', sha256: 'cc' }];
const both = (a: Entry, b: Entry = a): Both => ({ '0.025': a, '0.05': b });
const levelsFile = (source: string, over: Partial<LevelsFile> = {}, level = 0.02): LevelsFile => ({
  schema: 'z0-levels/1', source, draws: 20_000, commit: 'c1', sources: MODULES, floorFlags: [],
  levels: { T1: { '0.05': entry(level * 2) }, T3: both(entry(level), entry(level * 2)), T2a: both(entry(level), entry(level * 2)), T2b: both(entry(level), entry(level * 2)), T2c: both(entry(level), entry(level * 2)) },
  ...over,
});

describe('minLevels', () => {
  const quiet = () => undefined;

  it('returns the lower level per test and threshold with its cell and file', () => {
    const pre = { ...levelsFile('pre-freeze', {}, 0.02), file: 'levels/pre-freeze.json' };
    const lowered = levelsFile('batch-1', {}, 0.02);
    lowered.levels.T3!['0.025'] = entry(0.018, 'resampled R');
    lowered.levels.T2b!['0.05'] = entry(0.05, 'zero one');
    const min = minLevels(pre, { ...lowered, file: 'levels/batch-1.json' }, quiet);
    expect(min.T3['0.025']).toEqual({ level: 0.018, setBy: 'resampled R', cell: { setting: 'resampled R', size: 0.02, simError: 0.001 }, file: 'levels/batch-1.json' });
    expect(min.T2b['0.05']).toMatchObject({ level: 0.04, file: 'levels/pre-freeze.json' });
    expect(min.T1['0.05']).toMatchObject({ level: 0.04, file: 'levels/pre-freeze.json' });
  });

  it('prints a different commit and does not refuse it', () => {
    const lines: string[] = [];
    const min = minLevels(levelsFile('pre-freeze'), levelsFile('batch-1', { commit: 'c2' }), (line: string) => lines.push(line));
    expect(min.T1['0.05'].level).toBe(0.04);
    expect(lines.join('\n')).toMatch(/c1.*c2/);
  });

  it('refuses two files of one source', () => {
    expect(() => minLevels(levelsFile('pre-freeze'), levelsFile('pre-freeze'), quiet)).toThrow(/pre-freeze file and one batch-1 file/);
    expect(() => minLevels(levelsFile('batch-1'), levelsFile('batch-1'), quiet)).toThrow(/pre-freeze file and one batch-1 file/);
  });

  it('refuses a sources mismatch and names the module', () => {
    const changed = MODULES.map((m) => (m.file.endsWith('z0-cost-solved.mjs') ? { ...m, sha256: 'zz' } : m));
    expect(() => minLevels(levelsFile('pre-freeze'), levelsFile('batch-1', { sources: changed }), quiet)).toThrow(/z0-cost-solved\.mjs/);
    expect(() => minLevels(levelsFile('pre-freeze'), levelsFile('batch-1', { sources: MODULES.slice(0, 2) }), quiet)).toThrow(/z0-verdict-r4\.mjs/);
  });

  it('refuses a missing test or threshold, in either file, and when both files miss it', () => {
    const { T3: omitted, ...noT3 } = levelsFile('batch-1').levels;
    expect(omitted).toBeDefined();
    expect(() => minLevels(levelsFile('pre-freeze'), levelsFile('batch-1', { levels: noT3 }), quiet)).toThrow(/batch-1 file has no level for T3/);
    const noThreshold = { ...levelsFile('pre-freeze').levels, T2b: { '0.05': entry(0.04) } };
    expect(() => minLevels(levelsFile('pre-freeze', { levels: noThreshold }), levelsFile('batch-1'), quiet)).toThrow(/pre-freeze file has no level for T2b at 0\.025/);
    expect(() => minLevels(levelsFile('pre-freeze', { levels: noThreshold }), levelsFile('batch-1', { levels: noThreshold }), quiet)).toThrow(/T2b at 0\.025/);
  });

  it('accepts the same tests and thresholds listed in another key order', () => {
    const reversed = (file: LevelsFile) => ({ ...file, levels: Object.fromEntries(Object.entries(file.levels).reverse().map(([test, byThreshold]) => [test, Object.fromEntries(Object.entries(byThreshold).reverse())])) });
    const min = minLevels(levelsFile('pre-freeze'), reversed(levelsFile('batch-1')), quiet);
    expect(Object.keys(min)).toEqual(['T1', 'T3', 'T2a', 'T2b', 'T2c']);
  });

  it('refuses files that hold different tests', () => {
    const extra = { ...levelsFile('batch-1').levels, T2aMiss: both(entry(0.02)) };
    expect(() => minLevels(levelsFile('pre-freeze'), levelsFile('batch-1', { levels: extra }), quiet)).toThrow(/different tests or thresholds/);
  });
});
