/** Z0 analyzer on generated records with known effects; numbers in test names follow the plan's test list.
 * The records are synthetic: they test the contract, filters and arithmetic, never hippo. */
import { describe, it, expect } from 'vitest';
import { parseZ0Records, parsePlan, validateCorpus } from '../scripts/token-eval/z0-records.mjs';
import { filterRecords, pairTasks } from '../scripts/token-eval/z0-filters.mjs';
import { generate, jsonl, type Generated, type Z0Record, type PlanCell } from './fixtures/z0-gen.js';

const BASE = generate();
const fresh = (): Generated => structuredClone(BASE);
const parse = (recs: readonly Z0Record[]) => parseZ0Records(jsonl(recs), 'runs.jsonl').records;
const at = (recs: readonly Z0Record[], arm: string, sequence: string, seed: number, position: number): number =>
  recs.findIndex((r) => r.arm === arm && r.sequence === sequence && r.seed === seed && r.position === position);
const runOf = (rs: readonly { sequence: string; seed: number }[], sequence: string, seed: number) =>
  rs.filter((r) => r.sequence === sequence && r.seed === seed);
const crash = (r: Z0Record): void => {
  Object.assign(r, { invalid: 'no-result', usage: null, turns: null, toolCalls: null, acceptancePassed: null, resolved: false, lessons: [] });
};

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

  it('26: missing teach, crashed records, leak records and a plan passed twice', () => {
    const { records, plan } = fresh();
    records.splice(at(records, 'A1', 'rn-repo1', 1, 3), 1);
    crash(records[at(records, 'A2', 'rn-repo2', 1, 0)]!);
    Object.assign(records[at(records, 'A5', 'rn-repo3', 1, 2)]!, { invalid: 'leak', leak: true });
    const c = corpus(records, plan);
    expect(c.unchecked).toHaveLength(4);
    const f = filterRecords(c.records, plan);
    expect(f.counts.A1.missing).toBe(1);
    expect(f.counts.A2.invalid).toBe(1);
    expect(f.counts.A5.invalid).toBe(0);
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

  it('9 and 20 (pairing): seeds 1-2 with a two-seed arm, and a crash in one arm drops the pair', () => {
    const { records } = fresh();
    crash(records[at(records, 'A1', 'rn-repo1', 1, 4)]!);
    const parsed = parse(records);
    expect(parsed.some((r: Z0Record) => r.arm === 'A1' && r.seed === 3)).toBe(true);
    expect(pairTasks(parsed, 'A4', 'A1').some((p: { t: Z0Record }) => p.t.seed === 3)).toBe(false);
    const pairs = pairTasks(parsed, 'A2', 'A1');
    expect(pairs.some((p: { t: Z0Record }) => p.t.sequence === 'rn-repo1' && p.t.seed === 1 && p.t.position === 4)).toBe(false);
    expect(pairs).toHaveLength(6 * 18 * 3 - 1);
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
    expect(f.counts.A1.voids).toBe(1);
    expect(f.counts.A2.voids).toBe(0);
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
