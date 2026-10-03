/** Z0 analyzer on generated records with known effects; numbers in test names follow the plan's test list.
 * The records are synthetic: they test the contract, filters and arithmetic, never hippo. */
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addUsage, holmAdjust, priceUsage, verdict } from '../dist/eval-stats.js';
import { RN_ARMS, parseZ0Records, parsePlan, validateCorpus } from '../scripts/token-eval/z0-records.mjs';
import { filterRecords, pairTasks } from '../scripts/token-eval/z0-filters.mjs';
import { BEHAVIOUR_SENTENCE, LESSONS_SENTENCE, NOT_RUN, SPECS, bothCodings, codexApply, holmVerdicts, inSets, meanBootstrap, repeatMistake, rotationSlots } from '../scripts/token-eval/z0-hypotheses.mjs';
import { g3, g4, g5 } from '../scripts/token-eval/z0-gates.mjs';
import { pooledVoids } from '../scripts/token-eval/z0-blind.mjs';
import { analyzeZ0, runCli } from '../scripts/token-eval/z0-analyze.mjs';
import { ARMS, PRICES, generate, jsonl, type GenOpts, type Generated, type Z0Record, type PlanCell } from './fixtures/z0-gen.js';

const BASE = generate();
const fresh = (): Generated => structuredClone(BASE);
const parse = (recs: readonly Z0Record[]) => parseZ0Records(jsonl(recs), 'runs.jsonl').records;
const at = (recs: readonly Z0Record[], arm: string, sequence: string, seed: number, position: number): number =>
  recs.findIndex((r) => r.arm === arm && r.sequence === sequence && r.seed === seed && r.position === position);
const runOf = (rs: readonly { sequence: string; seed: number }[], sequence: string, seed: number) =>
  rs.filter((r) => r.sequence === sequence && r.seed === seed);
const crash = (r: Z0Record, invalid = 'no-result'): void => {
  Object.assign(r, { invalid, usage: null, turns: null, toolCalls: null, acceptancePassed: null, resolved: false, lessons: [] });
};
const STAT = { iterations: 2000, seed: 1 };
const GRADING = { flippedLessons: [], acceptanceFlips: 0, readerSample: { n: 30, disagreements: 0 } };
const scoredOf = (g: Generated) => filterRecords(parse(g.records), g.plan).scored;
const analyze = (g: Generated, extra = {}) =>
  analyzeZ0(parse(g.records), { planCells: g.plan, prices: PRICES, grading: GRADING, unblind: true, ...STAT, ...extra });
const hyp = (opts: GenOpts) => analyze(generate(opts)).hypotheses;
const gatesOf = (g: Generated) => analyze(g, { unblind: false }).gates;
const te = (estimate: number, p: number, low: number, high: number, nullValue = 0) => ({ estimate, low, high, p, iterations: 2000, dropped: 0, nullValue });

function corpus(recs: readonly Z0Record[], plan: readonly PlanCell[]) {
  const records = parse(recs);
  return { records, ...validateCorpus(records, parsePlan(JSON.stringify(plan), 'plan.json')) };
}

describe('Z0 records contract', () => {
  it('1: each contract break rejects with its line number', () => {
    const rejects = (mutate: (rs: Z0Record[]) => number, pattern: RegExp): void => {
      const { records, plan } = fresh();
      const i = mutate(records);
      expect(() => corpus(records, plan)).toThrow(new RegExp(`runs\\.jsonl line ${i + 1}: .*${pattern.source}`));
    };
    rejects((rs) => { const i = at(rs, 'A1', 'rn-repo1', 1, 4); delete rs[i]!.usage!.extra; return i; }, /usage\.extra/);
    rejects((rs) => { const i = at(rs, 'A1', 'rn-repo1', 1, 4); Object.assign(rs[i]!, { kind: 'lesson' }); return i; }, /kind must be/);
    rejects((rs) => { const i = at(rs, 'A0', 'rn-repo1', 2, 4); rs[i]!.seed = 3; return i; }, /seed 3 is not run for A0/);
    rejects((rs) => { const i = at(rs, 'A1', 'rn-repo1', 1, 4); rs[i]!.familyId = null; return i; }, /familyId/);
    rejects((rs) => { const i = rs.findIndex((r) => r.resolved); rs[i]!.timedOut = true; return i; }, /resolved must equal/);
    rejects((rs) => { const i = at(rs, 'A2', 'rn-repo2', 1, 6); rs[i]!.lessons[0]!.lessonId = 'ghost'; return i; }, /lesson ghost is in no teach record/);
    rejects((rs) => { const i = at(rs, 'A2', 'rn-repo2', 1, 6); rs[i]!.tasksSinceTeach = 5; return i; }, /tasksSinceTeach 5 but 4 positions/);
    const { records, plan } = fresh();
    expect(() => validateCorpus([...parse(records), ...parse(records)], plan)).toThrow(/duplicate record for cell .*: runs\.jsonl line 1 and runs\.jsonl line 1$/);
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
    Object.assign(records[at(records, 'A5', 'rn-repo3', 1, 2)]!, { invalid: 'leak', leak: true });
    const c = corpus(records, plan);
    expect(c.unchecked).toHaveLength(6);
    expect(c.unchecked).toContain(`runs.jsonl line ${at(records, 'X2', 'x-repo1', 2, 3) + 1}`);
    const f = filterRecords(c.records, plan);
    expect([f.counts.A1.missing, f.counts.A2.invalid, f.counts.X2.invalid, f.counts.A5.invalid]).toEqual([1, 1, 1, 0]);
    expect(f.leaked).toEqual(['rn-repo3 seed 1']);
    const twice = [...parsePlan(JSON.stringify(plan), 'plan.json'), ...parsePlan(JSON.stringify(plan), 'plan.json')];
    expect(() => validateCorpus(c.records, twice)).toThrow(/duplicate planned cell .*: plan\.json entry 1 and plan\.json entry 1$/);
  });
});

describe('Z0 filters', () => {
  it('10: an unrestored retry voids the rest of its run in every arm, except in A0 and A4', () => {
    const voidedFrom = (arm: string, extra: Partial<Z0Record> = {}): number[] => {
      const { records, plan } = fresh();
      Object.assign(records[at(records, arm, 'rn-repo1', 1, 8)]!, { limitRetries: 1, ...extra });
      const run = runOf(filterRecords(parse(records), plan).scored, 'rn-repo1', 1);
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
    expect(runOf(f.scored, 'x-repo1', 1).every((r: Z0Record) => r.position < 8)).toBe(true);
    expect(runOf(f.scored, 'x-repo1', 1).filter((r: Z0Record) => r.position === 7)).toHaveLength(4);
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

  it('11, 13, 15, 24 (filters): voids, leaks, drops and abandoned runs leave every arm', () => {
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
    expect(runOf(f.scored, 'rn-repo4', 1).length + runOf(f.scored, 'rn-repo5', 2).length).toBe(0);
    expect(f.counts.A1.missing).toBe(10);
    expect(f.scored.some((r: Z0Record) => r.lessons.some((l) => l.lessonId === lesson))).toBe(false);
    expect(f.scored[at(f.scored, 'A2', 'rn-repo6', 1, 4)].resolved).toBe(true);
    const noA5 = fresh();
    const g = filterRecords(parse(noA5.records.filter((r) => r.arm !== 'A5')), noA5.plan);
    expect(g.abandoned).toHaveLength(18);
    expect(g.counts.A5.missing).toBe(18 * 6 * 3);
    const noX = filterRecords(parse(noA5.records.filter((r) => r.set !== 'X')), noA5.plan.filter((c) => !c.arm.startsWith('X')));
    expect(noX.arms).toEqual(['A0', 'A1', 'A2', 'A4', 'A5']);
    expect(() => corpus(noA5.records, noA5.plan.slice(1))).toThrow(/runs\.jsonl line 1: cell .* is not in any plan file/);
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
    const h = analyze(g).hypotheses;
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

  it('18, 19: attribution sentences; H2 reads Codex apply records only', () => {
    const behaviour = hyp({ knobs: { A2: { fail: 0.1 }, A5: { fail: 0.1 } } });
    expect([behaviour.verdicts.H1.final.verdict, behaviour.attribution.sentence]).toEqual(['win', BEHAVIOUR_SENTENCE]);
    expect(hyp({ knobs: { A2: { fail: 0.1 } } }).attribution.sentence).toBe(LESSONS_SENTENCE);
    const h2 = (opts: GenOpts) => bothCodings(scoredOf(generate(opts)), 'X2', 'X3', STAT, codexApply);
    expect(h2({ knobs: { X2: { teachFail: 1 }, X3: { teachFail: 0 } } })).toEqual(h2({}));
  });

  it('21: reported subsets, the carry-union sensitivity block and rotation slots', () => {
    const g = fresh();
    for (const r of g.records) {
      if (r.kind === 'apply' && r.set === 'R' && (r.arm === 'A1' || r.arm === 'A2')) r.lessons[0]!.first = r.arm === 'A2' && r.applyIndex! > 1 ? 'fail' : 'pass';
    }
    g.records[at(g.records, 'A5', 'rn-repo1', 1, 3)]!.carryUnionMerges = 1;
    const { hypotheses: h, reported: rep } = analyze(g);
    expect(h.H1.violation.estimate).toBeGreaterThan(0);
    expect(rep.firstApply.H1.violation.estimate).toBe(0);
    expect([h.H1.violation.units, rep.maintainerOnly.H1.violation.units, rep.sensitivity.H1.violation.units]).toEqual([72, 54, 68]);
    expect(rep.sensitivity.carryUnionRuns).toBe(1);
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
    expect([r.gates.failed, r.hypotheses]).toEqual([['G1'], null]);
    expect(analyze(generate({ knobs: { A4: { fail: 0.6 } } }))).toMatchObject({ gates: { failed: ['G2'] }, hypotheses: null });
    const oneCoding = gatesOf(generate({ knobs: { A4: { na: 0.5, fail: 0.05 } } })).G2.claudeCode;
    expect([oneCoding.violation.estimate > -0.3, oneCoding.excluded.estimate <= -0.3, oneCoding.pass]).toEqual([true, true, false]);
    const noX = analyze(generate({ arms: RN_ARMS }));
    expect([noX.gates.pass, noX.gates.G2.codex.status, noX.hypotheses.verdicts.H2.final.verdict]).toEqual([true, NOT_RUN, NOT_RUN]);
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

  it('15, 24: G5 outcomes; abandoned tails count in G4; a planned arm with no records fails G4', () => {
    const sample = (n: number, disagreements: number) => g5({ ...GRADING, acceptanceFlips: 2, readerSample: { n, disagreements } });
    expect([sample(29, 0).status, sample(30, 4).status, sample(30, 3).status, g5(null).pass]).toEqual(['reader sample short', 're-grade required', 'pass', false]);
    expect(sample(30, 3).acceptanceFlips).toBe(2);
    const cut = fresh();
    cut.records = cut.records.filter((r) => !(r.sequence === 'rn-repo5' && r.seed === 2 && r.position >= 8));
    expect(gatesOf(cut).G4.perArm.A1.missing).toBe(10);
    const noA5 = fresh();
    expect(gatesOf({ records: noA5.records.filter((r) => r.arm !== 'A5'), plan: noA5.plan }).failed).toContain('G4');
    expect(hyp({ arms: ARMS.filter((a) => a !== 'A5') }).attribution).toBe(NOT_RUN);
  });
});

describe('Z0 CLI and blind mode', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const ARM_NAME = /\b(A0|A1|A2|A4|A5|X1|X2|X3|X4)\b/;
  const ARGS = ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--grading', 'grading.json'];
  function workspace(g: Generated): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-analyze-'));
    dirs.push(dir);
    const files = { 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES),
      'grading.json': JSON.stringify(GRADING), 'drop.json': JSON.stringify({ droppedLessons: [], droppedFamilies: [] }) };
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
    return dir;
  }

  it('16, 22, 23: blind output names no arm, pools void reasons, reuses its key, is deterministic and hashes its inputs', () => {
    const g = fresh();
    g.records[at(g.records, 'A1', 'rn-repo2', 1, 7)]!.void = 'received-hippo-text';
    g.records[at(g.records, 'X3', 'x-repo2', 1, 7)]!.void = 'read-past-transcript';
    const dir = workspace(g);
    const run = () => runCli([...ARGS, '--iterations', '300', '--out', 'out.json'], dir);
    const first = run();
    const out = fs.readFileSync(path.join(dir, 'out.json'), 'utf8');
    expect(first.code).toBe(0);
    for (const text of [first.stdout, out]) {
      expect(text).not.toMatch(ARM_NAME);
      expect(text).not.toMatch(/resolveRate|costPerResolved|staleFollow|verdict|adjustedP|voidReasons/);
    }
    const report = JSON.parse(out);
    expect(report.voids).toEqual({ total: 2, reasons: { 'read-past-transcript': 1, 'received-hippo-text': 1 } });
    expect(pooledVoids({ A1: { voids: 1, voidReasons: { x: 1 } }, A2: { voids: 0, voidReasons: {} } })).toEqual({ total: 1 });
    expect(first.stdout).toContain('hypotheses sealed until unblinded');
    expect(first.stdout).toContain('not of record');
    const key = fs.readFileSync(path.join(dir, 'z0-blind-key.json'), 'utf8');
    expect(Object.values(JSON.parse(key).codes).sort()).toEqual(ARMS.map((_, i) => `K${i + 1}`).sort());
    expect([run().code, fs.readFileSync(path.join(dir, 'z0-blind-key.json'), 'utf8'), fs.readFileSync(path.join(dir, 'out.json'), 'utf8')]).toEqual([0, key, out]);
    const repo = path.resolve(__dirname, '..');
    for (const h of report.hashes) {
      const file = h.role === 'source' ? path.join(repo, h.file) : path.join(dir, h.file);
      expect(h.sha256).toBe(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
    expect(report.hashes.map((h: { role: string }) => h.role).filter((r: string) => r === 'source')).toHaveLength(8);
    fs.writeFileSync(path.join(dir, 'z0-blind-key.json'), JSON.stringify({ codes: { A0: 'K1', A1: 'K2' } }));
    expect(run()).toMatchObject({ code: 1, stderr: expect.stringMatching(/another arm set/) });
  });

  it('17: unblind needs a committed drop list and grading file and a passing G5', () => {
    const dir = workspace(generate({ repos: 3 }));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    for (const [k, v] of [['user.name', 'z0 test'], ['user.email', 'z0@example.invalid'], ['core.hooksPath', '.no-hooks'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
    const unblind = (extra: string[] = []) => runCli([...ARGS, '--drop-list', 'drop.json', '--unblind', ...extra], dir);
    const edit = (f: string, text: string) => fs.writeFileSync(path.join(dir, f), text);
    expect(unblind().code).toBe(2);
    git('add', 'drop.json');
    git('commit', '-qm', 'drop list');
    expect(unblind()).toMatchObject({ code: 2, stderr: expect.stringMatching(/grading\.json is not tracked/) });
    git('add', 'grading.json');
    git('commit', '-qm', 'grading');
    const drop = fs.readFileSync(path.join(dir, 'drop.json'), 'utf8');
    edit('drop.json', `${drop}\n`);
    expect(unblind()).toMatchObject({ code: 2, stderr: expect.stringMatching(/drop\.json has uncommitted changes/) });
    edit('drop.json', drop);
    edit('grading.json', JSON.stringify({ ...GRADING, readerSample: { n: 30, disagreements: 4 } }));
    git('commit', '-qam', 'regrade needed');
    expect(unblind()).toMatchObject({ code: 2, stderr: expect.stringMatching(/re-grade required/) });
    edit('grading.json', JSON.stringify(GRADING));
    git('commit', '-qam', 'regraded');
    expect(runCli([...ARGS.slice(0, 6), '--drop-list', 'drop.json', '--unblind'], dir)).toMatchObject({ code: 2, stderr: expect.stringMatching(/grading file missing/) });
    expect(unblind(['--iterations', '300']).code).toBe(2);
    const open = unblind(['--out', 'open.json']);
    expect(open.code).toBe(0);
    expect(open.stdout).toMatch(/^H1 \w+/m);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'open.json'), 'utf8')).hypotheses.verdicts.H1.final.verdict).toBeTruthy();
    const bad = generate({ repos: 3 });
    bad.records[0]!.void = 'operator-canary';
    edit('runs.jsonl', jsonl(bad.records));
    const shut = unblind();
    expect([shut.code, ARM_NAME.test(shut.stdout), /^H1 /m.test(shut.stdout)]).toEqual([0, true, false]);
    expect(shut.stdout).toContain('invalid: G1');
  });
});
