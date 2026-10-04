/** Z0 analyzer on generated records with known effects; numbers in test names follow the plan's test list.
 * The records are synthetic: they test the contract, filters and arithmetic, never hippo. CLI tests: token-eval-z0-analyze-cli.test.ts. */
import { describe, it, expect } from 'vitest';
import { addUsage, holmAdjust, priceUsage, verdict } from '../dist/eval-stats.js';
import { RN_ARMS, parseZ0Records, parsePlan, validateCorpus } from '../scripts/token-eval/z0-records.mjs';
import { filterRecords, pairTasks } from '../scripts/token-eval/z0-filters.mjs';
import { BEHAVIOUR_SENTENCE, LESSONS_SENTENCE, NOT_RUN, NO_N_DATA, SPECS, bothCodings, codexApply, computeHypotheses, holmVerdicts, inSets, meanBootstrap, repeatMistake, rotationSlots } from '../scripts/token-eval/z0-hypotheses.mjs';
import { g3, g4, g5 } from '../scripts/token-eval/z0-gates.mjs';
import { analyzeZ0, buildReport, renderText } from '../scripts/token-eval/z0-analyze.mjs';
import { ARMS, GRADING, PRICES, at, crash, generate, jsonl, planOf, type GenOpts, type Generated, type Z0Record, type PlanCell } from './fixtures/z0-gen.js';

const BASE = generate();
const fresh = (): Generated => structuredClone(BASE);
const parse = (recs: readonly Z0Record[]) => parseZ0Records(jsonl(recs), 'runs.jsonl').records;
const runOf = <R extends { sequence: string; seed: number }>(rs: readonly R[], sequence: string, seed: number): R[] =>
  rs.filter((r) => r.sequence === sequence && r.seed === seed);
const STAT = { iterations: 2000, seed: 1 };
const scoredOf = (g: Generated) => filterRecords(parse(g.records), g.plan).scored;
const analyze = (g: Generated, extra = {}) =>
  analyzeZ0(parse(g.records), { planCells: g.plan, prices: PRICES, grading: GRADING, unblind: true, refuse: () => null, ...STAT, ...extra });
/** A report block the module types as a union with 'not run' or null; every block the tests read is present, so a primitive here is a test bug. */
type Real<T> = [Extract<T, object>] extends [never] ? T : Merged<Extract<T, object>>;
type KeysOf<U> = U extends unknown ? keyof U : never;
type ValueAt<U, K extends PropertyKey> = U extends unknown ? (K extends keyof U ? U[K] : never) : never;
type Merged<U> = [U] extends [readonly unknown[]] ? U : { [K in KeysOf<U>]-?: Real<ValueAt<U, K>> };
const real = <T>(x: T): Real<T> => {
  if (Object(x) !== x) throw new Error(`expected a report block, got ${String(x)}`);
  // SAFETY: the check above rules out null, undefined and strings; deeper fields are asserted by the tests that read them.
  return x as Real<T>;
};
const hyp = (opts: GenOpts) => real(analyze(generate(opts)).hypotheses);
const gatesOf = (g: Generated) => real(analyze(g, { unblind: false }).gates);
const te = (estimate: number, p: number, low: number, high: number, nullValue = 0) => ({ estimate, low, high, p, iterations: 2000, dropped: 0, nullValue });

function corpus(recs: readonly Z0Record[], plan: readonly object[]) {
  const records = parse(recs);
  return { records, ...validateCorpus(records, parsePlan(JSON.stringify(plan), 'plan.json')) };
}

describe('Z0 records contract', () => {
  it('1: each contract break rejects with its line number', () => {
    const rejects = (mutate: (rs: Z0Record[], plan: PlanCell[]) => number, pattern: RegExp): void => {
      const { records, plan } = fresh();
      const i = mutate(records, plan);
      expect(() => corpus(records, plan)).toThrow(new RegExp(`runs\\.jsonl line ${i + 1}: .*${pattern.source}`));
    };
    rejects((rs) => { const i = at(rs, 'A1', 'rn-repo1', 1, 4); Reflect.deleteProperty(rs[i]!.usage!, 'extra'); return i; }, /usage\.extra/);
    rejects((rs) => { const i = at(rs, 'A1', 'rn-repo1', 1, 4); Object.assign(rs[i]!, { kind: 'lesson' }); return i; }, /kind must be/);
    rejects((rs) => { const i = at(rs, 'A0', 'rn-repo1', 2, 4); rs[i]!.seed = 3; return i; }, /seed 3 is not run for A0/);
    rejects((rs) => { const i = at(rs, 'A1', 'rn-repo1', 1, 4); rs[i]!.familyId = null; return i; }, /familyId/);
    rejects((rs) => { const i = rs.findIndex((r) => r.resolved); rs[i]!.timedOut = true; return i; }, /resolved must equal/);
    rejects((rs) => { const i = at(rs, 'A2', 'rn-repo2', 1, 6); rs[i]!.lessons[0]!.lessonId = 'ghost'; return i; }, /lesson ghost is in no teach record/);
    rejects((rs) => { const i = at(rs, 'A2', 'rn-repo2', 1, 6); rs[i]!.tasksSinceTeach = 5; return i; }, /tasksSinceTeach 5 but 4 positions/);
    rejects((rs, plan) => { const i = at(rs, 'A1', 'rn-repo2', 1, 0); rs[i]!.familyId = plan[i]!.familyId = 'rn-repo1-f0'; return i; }, /familyId rn-repo1-f0 appears in repos repo1 and repo2/);
    rejects((rs) => { const i = at(rs, 'A2', 'rn-repo3', 2, 5); rs[i]!.taskId = 'other'; return i; }, /taskId other but the plan has rn-repo3-t5/);
    const { records, plan } = fresh();
    expect(() => validateCorpus([...parse(records), ...parse(records)], plan)).toThrow(/duplicate record for cell .*: runs\.jsonl line 1 and runs\.jsonl line 1$/);
    expect(() => parsePlan('[]', 'plan.json')).toThrow(/^plan\.json: the plan has no cells$/);
  });

  it('25: a timeout or an na final is never resolved, before or after drops', () => {
    const { records, plan } = fresh();
    const i = at(records, 'A1', 'rn-repo1', 1, 4);
    Object.assign(records[i]!, { timedOut: true, acceptancePassed: true, resolved: true });
    records[i]!.lessons[0]!.final = 'pass';
    expect(() => parse(records)).toThrow(/line \d+: resolved must equal/);
    records[i]!.resolved = false;
    const flipped = filterRecords(parse(records), plan, { grading: { flippedLessons: [records[i]!.lessons[0]!.lessonId] } });
    expect(flipped.scored.find((r: Z0Record) => r.arm === 'A1' && r.sequence === 'rn-repo1' && r.seed === 1 && r.position === 4).resolved).toBe(false);
    Object.assign(records[i]!, { timedOut: false, resolved: true });
    records[i]!.lessons[0]!.final = 'na';
    expect(() => parse(records)).toThrow(/resolved must equal/);
  });

  it('26: missing or invalid teach, crashed records, leak records and a plan passed twice', () => {
    const { records, plan } = fresh();
    records.splice(at(records, 'A1', 'rn-repo1', 1, 3), 1);
    crash(records[at(records, 'A2', 'rn-repo2', 1, 0)]!);
    crash(records[at(records, 'X2', 'x-repo1', 2, 0)]!, 'checker');
    Object.assign(records[at(records, 'A5', 'rn-repo3', 1, 2)]!, { invalid: 'leak', leak: true, resolved: false });
    const c = corpus(records, plan);
    expect(c.unchecked).toHaveLength(6);
    expect(c.unchecked).toContain(`runs.jsonl line ${at(records, 'X2', 'x-repo1', 2, 3) + 1}`);
    const f = filterRecords(c.records, plan);
    expect([f.counts.A1.missing, f.counts.A2.invalid, f.counts.X2.invalid, f.counts.A5.invalid]).toEqual([1, 1, 1, 0]);
    expect(f.leaked).toEqual(['rn-repo3 seed 1']);
    const twice = [...parsePlan(JSON.stringify(plan), 'plan.json'), ...parsePlan(JSON.stringify(plan), 'plan.json')];
    expect(() => validateCorpus(c.records, twice)).toThrow(/duplicate planned cell .*: plan\.json entry 1 and plan\.json entry 1$/);
  });

  it('27: an invalid record must be unresolved, whatever its acceptance tests said', () => {
    const { records } = fresh();
    const i = at(records, 'A2', 'rn-repo1', 1, 4);
    crash(records[i]!, 'no-transcript');
    Object.assign(records[i]!, { acceptancePassed: true, fileReads: null, wallMs: null, teachTurns: null, correctionTurns: null });
    expect(parse(records)[i].resolved).toBe(false);
    records[i]!.resolved = true;
    expect(() => parse(records)).toThrow(new RegExp(`line ${i + 1}: resolved must be false on an invalid record`));
  });

  it('31: a pair must share its task, and every arm runs one task per position', () => {
    const g = fresh();
    const i = at(g.records, 'A2', 'rn-repo2', 1, 6);
    g.records[i]!.taskId = 'other';
    const parsed = parse(g.records);
    expect(() => pairTasks(parsed, 'A2', 'A1')).toThrow(/rn-repo2#1@6: A2 ran task other and A1 ran rn-repo2-t6/);
    const noIds = g.plan.map((c) => ({ ...c, taskId: undefined, repo: undefined }));
    expect(() => validateCorpus(parsed, noIds)).toThrow(new RegExp(`runs\\.jsonl line ${i + 1}: taskId other but runs\\.jsonl line \\d+ has rn-repo2-t6`));
  });

  it('34: a plan cell carries set, kind and familyId under the record rules, and a record must match its cell', () => {
    const { records, plan } = fresh();
    const teach = at(plan, 'A1', 'rn-repo1', 1, 0);
    const noLesson = at(plan, 'A1', 'rn-repo1', 1, 2);
    type CellEdit = Partial<Record<'set' | 'kind' | 'familyId' | 'arm', string | null | undefined>>;
    const edited = (i: number, edit: CellEdit) => plan.map((c, j) => (j === i ? { ...c, ...edit } : c));
    const cases: [number, CellEdit, RegExp][] = [
      [teach, { set: 'Q' }, /set must be R, N or X/],
      [teach, { kind: 'lesson' }, /kind must be teach, apply or no-lesson/],
      [teach, { familyId: null }, /familyId is a string for teach and apply/],
      [teach, { arm: 'X1' }, /arm X1 is not an arm of set R/],
      [noLesson, { set: 'R' }, /kind no-lesson appears only in set N/],
      [noLesson, { familyId: 'rn-repo1-f0' }, /null for no-lesson/],
    ];
    for (const [i, edit, pattern] of cases) {
      expect(() => parsePlan(JSON.stringify(edited(i, edit)), 'plan.json')).toThrow(new RegExp(`^plan\\.json entry ${i + 1}: .*${pattern.source}`));
    }
    for (const [f, v] of [['set', 'N'], ['kind', 'apply'], ['familyId', 'rn-repo1-f1']]) {
      expect(() => corpus(records, edited(teach, { [f!]: v }))).toThrow(new RegExp(`runs\\.jsonl line ${teach + 1}: ${f} \\S+ but the plan has ${v} at cell`));
    }
  });

  it('37: a plan written before the lesson-families fields names the cause, not a field rule', () => {
    const { plan } = fresh();
    const cause = 'write the plan with a runner that includes the lesson-families fields';
    const old = plan.map(({ set: _s, kind: _k, familyId: _f, ...rest }) => rest);
    expect(() => parsePlan(JSON.stringify(old), 'plan.json')).toThrow(new RegExp(`^plan\\.json cell 1 has no set/kind/familyId: ${cause}$`));
    const noFamily = plan.map((c, j) => (j === 2 ? { ...c, familyId: undefined } : c));
    expect(() => parsePlan(JSON.stringify(noFamily), 'plan.json')).toThrow(new RegExp(`^plan\\.json cell 3 has no familyId: ${cause}$`));
  });
});

describe('Z0 filters', () => {
  it('10: an unrestored retry voids the rest of its run in every arm, except in A0 and A4', () => {
    const voidedFrom = (arm: string, extra: Partial<Z0Record> = {}): number[] => {
      const { records, plan } = fresh();
      Object.assign(records[at(records, arm, 'rn-repo1', 1, 8)]!, { limitRetries: 1, ...extra });
      const run = runOf<Z0Record>(filterRecords(parse(records), plan).scored, 'rn-repo1', 1);
      return [...new Set(run.map((r: Z0Record) => r.position))].sort((a, b) => a - b);
    };
    const upTo8 = Array.from({ length: 8 }, (_, i) => i);
    expect(voidedFrom('A2')).toEqual(upTo8);
    expect(voidedFrom('A2', { surfaceRestored: true })).toHaveLength(18);
    expect(voidedFrom('A0')).toHaveLength(18);
    expect(voidedFrom('A4')).toHaveLength(18);
    const { records, plan } = fresh();
    records[at(records, 'X4', 'x-repo1', 1, 8)]!.limitRetries = 1;
    const f = filterRecords(parse(records), plan);
    expect(runOf<Z0Record>(f.scored, 'x-repo1', 1).every((r: Z0Record) => r.position < 8)).toBe(true);
    expect(runOf<Z0Record>(f.scored, 'x-repo1', 1).filter((r: Z0Record) => r.position === 7)).toHaveLength(4);
    expect(f.retryVoided.positions).toBe(6);
  });

  it('9 and 20: seeds 1-2 with a two-seed arm; a crash drops the pair, and a unit left empty is dropped and listed', () => {
    const { records } = fresh();
    crash(records[at(records, 'A1', 'rn-repo1', 1, 4)]!);
    const parsed = parse(records);
    expect(parsed.some((r: Z0Record) => r.arm === 'A1' && r.seed === 3)).toBe(true);
    expect(pairTasks(parsed, 'A4', 'A1').some((p: { t: Z0Record }) => p.t.seed === 3)).toBe(false);
    const pairs = pairTasks(parsed, 'A2', 'A1');
    expect(pairs.some((p: { t: Z0Record }) => p.t.sequence === 'rn-repo1' && p.t.seed === 1 && p.t.position === 4)).toBe(false);
    expect(pairs).toHaveLength(6 * 18 * 3 - 1);
    const g = fresh();
    const a4a1 = () => repeatMistake(scoredOf(g), 'A4', 'A1', 'violation', STAT, inSets('R'));
    const before = a4a1();
    for (const r of g.records) if (r.arm === 'A1' && r.seed === 3) for (const l of r.lessons) l.first = 'fail';
    expect(a4a1()).toEqual(before);
    for (const p of [4, 11]) crash(g.records[at(g.records, 'A1', 'rn-repo1', 1, p)]!);
    const h1 = repeatMistake(scoredOf(g), 'A2', 'A1', 'violation', STAT, inSets('R'));
    expect([h1.units, h1.droppedUnits, h1.dropped]).toEqual([71, ['rn-repo1-f0 seed 1'], 0]);
  });

  it('11, 13, 15, 24 (filters): voids, leaks and drops leave every arm; abandoned runs are listed', () => {
    const { records, plan } = fresh();
    records[at(records, 'A1', 'rn-repo2', 2, 6)]!.void = 'read-past-transcript';
    records[at(records, 'A2', 'rn-repo4', 1, 2)]!.leak = true;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]!;
      if (r.sequence === 'rn-repo5' && r.seed === 2 && r.position >= 8) records.splice(i, 1);
    }
    records[at(records, 'A5', 'rn-repo5', 2, 2)]!.leak = true;
    const lesson = 'rn-repo6-f0-L1';
    const j = at(records, 'A2', 'rn-repo6', 1, 4);
    Object.assign(records[j]!, { acceptancePassed: true, resolved: false });
    records[j]!.lessons[0]!.final = 'fail';
    const f = filterRecords(parse(records), plan, { grading: { flippedLessons: [lesson] } });
    expect([f.counts.A1.voids, f.counts.A2.voids]).toEqual([1, 0]);
    expect(f.scored.some((r: Z0Record) => r.sequence === 'rn-repo2' && r.seed === 2 && r.position === 6)).toBe(false);
    expect(f.leaked).toEqual(['rn-repo4 seed 1', 'rn-repo5 seed 2']);
    expect(f.abandoned).toEqual(['rn-repo5 seed 2']);
    expect(runOf<Z0Record>(f.scored, 'rn-repo4', 1).length + runOf<Z0Record>(f.scored, 'rn-repo5', 2).length).toBe(0);
    expect([f.counts.A1.missing, f.counts.A1.abandoned]).toEqual([0, 10]);
    expect(f.scored.some((r: Z0Record) => r.lessons.some((l) => l.lessonId === lesson))).toBe(false);
    expect(f.scored[at(f.scored, 'A2', 'rn-repo6', 1, 4)].resolved).toBe(true);
    const noA5 = fresh();
    const g = filterRecords(parse(noA5.records.filter((r) => r.arm !== 'A5')), noA5.plan);
    expect(g.abandoned).toHaveLength(18);
    expect([g.counts.A5.missing, g.counts.A5.abandoned]).toEqual([0, 18 * 6 * 3]);
    const noX = filterRecords(parse(noA5.records.filter((r) => r.set !== 'X')), noA5.plan.filter((c) => !c.arm.startsWith('X')));
    expect(noX.arms).toEqual(['A0', 'A1', 'A2', 'A4', 'A5']);
    expect(() => corpus(noA5.records, noA5.plan.slice(1))).toThrow(/runs\.jsonl line 1: cell .* is not in any plan file/);
  });

  it('28: an apply whose own arm missed its latest planned teach leaves every arm, counted as an untaught-apply drop', () => {
    const g = fresh();
    crash(g.records[at(g.records, 'A2', 'rn-repo1', 1, 0)]!);
    const f = filterRecords(parse(g.records), g.plan);
    expect(f.untaughtApplyDrops).toBe(2);
    expect(runOf<Z0Record>(f.scored, 'rn-repo1', 1).filter((r: Z0Record) => r.position === 4 || r.position === 11)).toEqual([]);
    const h1 = repeatMistake(f.scored, 'A2', 'A1', 'violation', STAT, inSets('R'));
    expect([h1.units, h1.droppedUnits]).toEqual([71, []]);
    // Family 3 is taught at 5 and re-taught at 14; its applies sit at 9, 12 and 17.
    const reteach = fresh();
    crash(reteach.records[at(reteach.records, 'A2', 'rn-repo1', 1, 5)]!);
    const r = filterRecords(parse(reteach.records), reteach.plan);
    const arms = (p: number) => runOf<Z0Record>(r.scored, 'rn-repo1', 1).filter((x: Z0Record) => x.position === p).length;
    expect([r.untaughtApplyDrops, arms(9), arms(12), arms(17)]).toEqual([2, 0, 0, 5]);
  });

  it('35: a teach position missing in every arm drops only its own family\'s applies, read from the plan', () => {
    const gone = fresh();
    gone.records = gone.records.filter((x) => !(x.sequence === 'rn-repo1' && x.seed === 1 && x.position === 1));
    const m = filterRecords(parse(gone.records), gone.plan);
    expect([m.untaughtApplyDrops, m.counts.A1.missing, runOf<Z0Record>(m.scored, 'rn-repo1', 1).length]).toEqual([2, 1, 90 - 5 - 10]);
  });
});

describe('Z0 hypotheses', () => {
  it('2, 3, 4: H1 win, a coding split, and a loss under one coding', () => {
    expect(hyp({ knobs: { A2: { fail: 0.1 } } }).verdicts.H1.final).toEqual({ verdict: 'win', reachesMinimum: true });
    const split = hyp({ knobs: { A2: { na: 0.4, fail: 0.1 } } }).verdicts.H1;
    expect([split.violation.verdict === 'win', split.excluded.verdict, split.final.verdict]).toEqual([false, 'win', 'inconclusive']);
    const loss = hyp({ knobs: { A1: { fail: 0.2 }, A2: { na: 0.6, fail: 0.08 } } });
    expect([loss.verdicts.H1.violation.verdict, loss.verdicts.H1.excluded.verdict === 'loss', loss.verdicts.H1.final.verdict]).toEqual(['loss', false, 'loss']);
    expect(loss.order[0]).toBe('H1');
  });

  it('5: H1 band cases on fixed unit differences, CI asserted before the verdict', () => {
    const read = (vals: number[], repos: number) => {
      const e = meanBootstrap(vals.map((value, i) => ({ repo: `r${i % repos}`, family: `f${i}`, value })), STAT);
      return { e, v: verdict(e, e.p, SPECS.H1) };
    };
    const tie = read(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1)), 8);
    expect(tie.e.low >= -0.15 && tie.e.high <= 0.15 && tie.e.low <= 0 && tie.e.high >= 0).toBe(true);
    expect(tie.v.verdict).toBe('tie');
    const small = read(Array.from({ length: 40 }, (_, i) => -0.05 + 0.01 * ((i % 3) - 1)), 8);
    expect(small.e.p).toBeLessThan(0.05);
    expect(small.v).toEqual({ verdict: 'win', reachesMinimum: false });
    const wide = read([-0.4, -0.3, -0.1, 0, 0.1, 0.3], 3);
    expect(wide.e.low < -0.15 && wide.e.high > -0.15).toBe(true);
    expect(wide.v.verdict).toBe('inconclusive');
  });

  it('6: H3 is the ratio of summed costs on heterogeneous tasks, with its splits', () => {
    const heavy = (s: { position: number }) => s.position % 3 === 0;
    const g = generate({ knobs: { A1: { cost: (s) => (heavy(s) ? 10 : 1) }, A2: { cost: (s) => (heavy(s) ? 7 : 1.2) } } });
    const h = real(analyze(g).hypotheses);
    const cost = (r: Z0Record) => priceUsage(addUsage(r.usage!.firstSession, r.usage!.extra), PRICES['claude-code']);
    const [t, c] = ['A2', 'A1'].map((arm) => g.records.filter((r) => r.arm === arm && r.set !== 'X').map(cost));
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    expect(h.H3.estimate).toBeCloseTo(sum(t!) / sum(c!), 12);
    expect(Math.abs(sum(t!.map((x, i) => x / c![i]!)) / t!.length - h.H3.estimate)).toBeGreaterThan(0.05);
    expect(h.verdicts.H3.final).toEqual({ verdict: 'win', reachesMinimum: true });
    expect([h.H3.firstSession.estimate, h.H3.extra.estimate].every(Number.isFinite)).toBe(true);
  });

  it('7: H4 fails on cost or on resolve and leads the report', () => {
    const cost = hyp({ knobs: { A1: { resolve: 1 }, A2: { resolve: 1, cost: (s) => (s.set === 'N' ? 1.2 : 0.96) } } });
    expect([cost.H4.gate.costOk, cost.H4.gate.pass, cost.order[0]]).toEqual([false, false, 'H4']);
    const resolve = hyp({ knobs: { A1: { resolve: 1 }, A2: { resolve: 0.9 } } });
    expect([resolve.H4.gate.resolveOk, resolve.H4.gate.pass]).toEqual([false, false]);
    // Reading 20: H1 to H3 losses lead, then a failed H4, then the rest.
    const both = hyp({ knobs: { A1: { resolve: 1 }, A2: { resolve: 1, fail: 0.9, cost: (s) => (s.set === 'N' ? 1.2 : 0.96) } } });
    const losses = ['H1', 'H2', 'H3'].filter((h) => both.verdicts[h].final.verdict === 'loss');
    expect([both.H4.gate.pass, losses[0], both.order.indexOf('H4')]).toEqual([false, 'H1', losses.length]);
  });

  it('29: H4 is not run without set N in the plan, and fails when filters leave set N empty', () => {
    const records = fresh().records.filter((r) => r.set !== 'N');
    const none = analyze({ records, plan: planOf(records) });
    const open = real(none.hypotheses);
    expect([open.H4, open.order.at(-2), none.unplanned]).toEqual([NOT_RUN, 'H4', ['set N']]);
    const voided = fresh();
    for (const r of voided.records) if (r.set === 'N' && r.arm === 'A1') r.void = 'read-past-transcript';
    const h = real(analyze(voided).hypotheses);
    expect([h.H4.reason, h.H4.gate.pass, h.order[0]]).toEqual([NO_N_DATA, false, 'H4']);
    const full = fresh();
    const missingN = filterRecords(parse(full.records.filter((r) => r.set !== 'N')), full.plan);
    expect([missingN.sets, missingN.abandoned, real(computeHypotheses(missingN, PRICES, STAT)).H4.reason]).toEqual([['N', 'R', 'X'], [], NO_N_DATA]);
  });

  it('8: Holm runs once per coding, then the codings combine', () => {
    const h3 = te(0.85, 0.03, 0.75, 0.97, 1);
    const rm = (p: number) => te(-0.3, p, -0.4, -0.2);
    const v = holmVerdicts({ violation: { H1: rm(0.001), H2: rm(0.02), H3: h3 }, excluded: { H1: rm(0.02), H2: rm(0.001), H3: h3 } });
    // Per coding: Holm([.001, .02, .03]) gives H3 max(.04, .03) = .04, a win under both codings.
    expect(v.H3.violation.adjustedP).toBeCloseTo(0.04, 12);
    expect(v.H3.final.verdict).toBe('win');
    // Six-way Holm over (H1v, H1e, H2v, H2e, H3, H3) gives H3 .08; Holm on max-over-codings ps (.02, .02, .03) gives .06.
    expect(holmAdjust([0.001, 0.02, 0.02, 0.001, 0.03, 0.03])[4]).toBeCloseTo(0.08, 12);
    expect(holmAdjust([0.02, 0.02, 0.03])[2]).toBeCloseTo(0.06, 12);
    expect([verdict(h3, 0.08, SPECS.H3).verdict, verdict(h3, 0.06, SPECS.H3).verdict]).toEqual(['inconclusive', 'inconclusive']);
    const bad = (p: number) => te(0.2, p, 0.1, 0.3);
    const loss = holmVerdicts({ violation: { H1: bad(0.01), H2: rm(0.5), H3: te(1, 0.04, 0.97, 1.03, 1) }, excluded: { H1: bad(0.04), H2: rm(0.04), H3: te(1, 0.04, 0.97, 1.03, 1) } });
    expect([loss.H1.violation.verdict, loss.H1.excluded.verdict, loss.H1.final.verdict]).toEqual(['loss', 'inconclusive', 'loss']);
  });

  it('18, 19: attribution words a winning H1 only, the behaviour sentence when A5 is not planned; H2 reads Codex apply records only', () => {
    const behaviour = hyp({ knobs: { A2: { fail: 0.1 }, A5: { fail: 0.1 } } });
    expect([behaviour.verdicts.H1.final.verdict, behaviour.attribution.sentence]).toEqual(['win', BEHAVIOUR_SENTENCE]);
    expect(hyp({ knobs: { A2: { fail: 0.1 } } }).attribution.sentence).toBe(LESSONS_SENTENCE);
    // A2 beats A5 here, yet a tie gets no sentence.
    const tie = hyp({ knobs: { A5: { fail: 0.9 } } });
    expect([tie.verdicts.H1.final.verdict, tie.attribution.sentence, tie.attribution.reason]).toEqual(['tie', null, 'not applicable, H1 is tie']);
    const loss = hyp({ knobs: { A2: { fail: 0.9 } } });
    expect([loss.verdicts.H1.final.verdict, loss.attribution.sentence, loss.attribution.reason]).toEqual(['loss', null, 'not applicable, H1 is loss']);
    // Without A5, A2 cannot have beaten it, so a win takes the behaviour sentence (148, "Otherwise").
    const noA5 = ARMS.filter((x) => x !== 'A5');
    const win = analyze(generate({ arms: noA5, knobs: { A2: { fail: 0.1 } } }));
    const winH = real(win.hypotheses);
    expect([winH.verdicts.H1.final.verdict, winH.attribution]).toEqual(['win', { sentence: BEHAVIOUR_SENTENCE, reason: 'A5 not run' }]);
    expect(renderText(buildReport(win, { warnings: [] }, {}, null, []))).toContain(`attribution: ${BEHAVIOUR_SENTENCE}; A2 vs A5 not run\n`);
    expect(hyp({ arms: noA5 }).attribution).toEqual({ sentence: null, reason: 'not applicable, H1 is tie' });
    const h2 = (opts: GenOpts) => bothCodings(scoredOf(generate(opts)), 'X2', 'X3', STAT, codexApply);
    expect(h2({ knobs: { X2: { teachFail: 1 }, X3: { teachFail: 0 } } })).toEqual(h2({}));
  });

  it('21, 33: reported subsets, per-arm rates by tasks since teach, the carry-union block and rotation slots', () => {
    const g = fresh();
    for (const r of g.records) {
      if (r.kind === 'apply' && r.set === 'R' && (r.arm === 'A1' || r.arm === 'A2')) r.lessons[0]!.first = r.arm === 'A2' && r.applyIndex! > 1 ? 'fail' : 'pass';
    }
    g.records[at(g.records, 'A5', 'rn-repo1', 1, 3)]!.carryUnionMerges = 1;
    const a = analyze(g);
    const h = real(a.hypotheses);
    const rep = real(a.reported);
    expect(h.H1.violation.estimate).toBeGreaterThan(0);
    expect(rep.firstApply.H1.violation.estimate).toBe(0);
    expect([h.H1.violation.units, rep.maintainerOnly.H1.violation.units, rep.sensitivity.H1.violation.units]).toEqual([72, 54, 68]);
    expect(rep.sensitivity.carryUnionRuns).toBe(1);
    const rates = rep.ratesBySinceTeach['2-4'];
    expect(Object.keys(rates)).toEqual(['A0', 'A1', 'A2', 'A4', 'A5']);
    expect([rates.A0.seeds, rates.A1.seeds, rates.A4.seeds]).toEqual([[1, 2], [1, 2, 3], [1, 2]]);
    // Same units on both sides and no na, so the rates' difference is the paired estimate.
    expect(rates.A2.violation.estimate - rates.A1.violation.estimate).toBeCloseTo(rep.bySinceTeach['2-4'].violation.estimate, 12);
    const slotOf = rotationSlots(g.records);
    const byPos = new Map<string, number[]>();
    for (const r of g.records) byPos.set(`${r.sequence}#${r.seed}@${r.position}`, [...(byPos.get(`${r.sequence}#${r.seed}@${r.position}`) ?? []), slotOf(r)]);
    for (const s of byPos.values()) expect([...s].sort((a, b) => a - b)).toEqual(s.map((_, i) => i + 1));
    expect(rep.rotation.length).toBeGreaterThan(0);
  });
});

describe('Z0 gates', () => {
  it('11, 12: an operator canary fails G1; G2 halves, codings and required arms', () => {
    const canary = fresh();
    canary.records[at(canary.records, 'A5', 'rn-repo3', 1, 5)]!.void = 'operator-canary';
    const r = analyze(canary);
    expect([real(r.gates).failed, r.hypotheses]).toEqual([['G1'], null]);
    // A canary seen only in an apply's resume leaves the cell's void to session 1 but still fails the run (prereg 161).
    const resumeOnly = fresh();
    const hit = { reason: 'operator-canary', class: null, tool: null, path: null, file: 'x.jsonl' };
    Object.assign(resumeOnly.records[at(resumeOnly.records, 'A1', 'rn-repo2', 1, 5)]!, { resumeVoidHits: [hit] });
    const g = analyze(resumeOnly);
    expect([real(g.gates).failed, real(g.gates).G1.operatorCanaries]).toEqual([['G1'], 1]);
    expect(analyze(generate({ knobs: { A4: { fail: 0.6 } } }))).toMatchObject({ gates: { failed: ['G2'] }, hypotheses: null });
    const oneCoding = gatesOf(generate({ knobs: { A4: { na: 0.5, fail: 0.05 } } })).G2.claudeCode;
    expect([oneCoding.violation.estimate > -0.3, oneCoding.excluded.estimate <= -0.3, oneCoding.pass]).toEqual([true, true, false]);
    const noX = analyze(generate({ arms: RN_ARMS }));
    expect([real(noX.gates).pass, real(noX.gates).G2.codex.status, real(noX.hypotheses).verdicts.H2.final.verdict]).toEqual([true, NOT_RUN, NOT_RUN]);
    for (const absent of ['A0', 'A4', 'X4']) {
      const g2 = gatesOf(generate({ arms: ARMS.filter((a) => a !== absent) })).G2;
      expect([g2.pass, (absent === 'X4' ? g2.codex : g2.claudeCode).status]).toEqual([false, NOT_RUN]);
    }
  });

  it('13: G3 counts leaked runs, 5% exactly passing', () => {
    expect([g3(1, 20).pass, g3(2, 20).pass]).toEqual([true, false]);
    const g = fresh();
    g.records[at(g.records, 'A2', 'rn-repo4', 1, 2)]!.leak = true;
    g.records[at(g.records, 'A2', 'rn-repo1', 2, 8)]!.limitRetries = 1;
    expect(gatesOf(g).G3).toMatchObject({ pass: true, leaked: 1, plannedRuns: 36 });
    g.records[at(g.records, 'X1', 'x-repo2', 2, 3)]!.leak = true;
    expect(gatesOf(g).G3.pass).toBe(false);
  });

  it('14: G4 per-arm threshold and gap, from counts taken before removals', () => {
    const counts = (bad: number[]) => Object.fromEntries(bad.map((b, i) => [`K${i}`, { planned: 200, invalid: b, missing: 0 }]));
    expect([g4(counts([10, 10, 10])).pass, g4(counts([11, 11, 11])).armsPass]).toEqual([true, false]);
    expect([g4(counts([2, 8])).gapPass, g4(counts([2, 9])).gapPass]).toEqual([true, false]);
    const g = fresh();
    g.records.splice(at(g.records, 'A1', 'rn-repo2', 1, 7), 1);
    g.records[at(g.records, 'A2', 'rn-repo2', 1, 9)]!.leak = true;
    g.records[at(g.records, 'A1', 'rn-repo3', 1, 9)]!.void = 'read-past-transcript';
    crash(g.records[at(g.records, 'A1', 'rn-repo3', 1, 9)]!);
    expect(gatesOf(g).G4.perArm.A1).toMatchObject({ missing: 1, invalid: 1 });
  });

  it('15, 24: G5 outcomes; an abandoned run is its own status, with no gate and no G4 missing', () => {
    const sample = (n: number, disagreements: number) => g5({ ...GRADING, acceptanceFlips: 2, readerSample: { n, disagreements } });
    expect([sample(29, 0).status, sample(30, 4).status, sample(30, 3).status, g5(null).pass]).toEqual(['reader sample short', 're-grade required', 'pass', false]);
    expect(real(sample(30, 3)).acceptanceFlips).toBe(2);
    const cut = fresh();
    cut.records = cut.records.filter((r) => !(r.sequence === 'rn-repo5' && r.seed === 2 && r.position >= 8));
    cut.records.splice(at(cut.records, 'A2', 'rn-repo1', 1, 5), 1);
    const a = analyze(cut);
    expect([a.status, a.gates, a.hypotheses, a.filtered.abandoned]).toEqual(['abandoned', null, null, ['rn-repo5 seed 2']]);
    expect([a.filtered.counts.A1.missing, a.filtered.counts.A1.abandoned, a.filtered.counts.A2.missing]).toEqual([0, 10, 1]);
    expect(a.refusal).toMatch(/abandoned/);
    const noA5 = fresh();
    const b = analyze({ records: noA5.records.filter((r) => r.arm !== 'A5'), plan: noA5.plan }, { unblind: false });
    expect([b.status, b.gates, b.filtered.counts.A5.abandoned]).toEqual(['abandoned', null, 324]);
  });

  it('38: an exported unblind with no refuse callback throws, so the commit check cannot be skipped', () => {
    const g = fresh();
    const opts = { planCells: g.plan, prices: PRICES, grading: GRADING, ...STAT };
    expect(() => analyzeZ0(parse(g.records), { ...opts, unblind: true })).toThrow(/^analyzeZ0: unblind needs a refuse callback/);
    expect(analyzeZ0(parse(g.records), { ...opts, unblind: false }).status).toBe('valid');
  });
});
