// Round 4 prereg items 6 and 7: analyze, size and the seed rule read a corpus through the one filter path, so a flip and an off-pin void act the same in all three.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { DESIGNS, OPUS_MODEL } from '../scripts/token-eval/arms.mjs';
import { analyzeZ0, loadInputs, parseArgs as parseAnalyze, runCli as analyzeCli } from '../scripts/token-eval/z0-analyze.mjs';
import * as blind from '../scripts/token-eval/z0-blind.mjs';
import { filterOpts, filteredInput } from '../scripts/token-eval/z0-filters.mjs';
import { computeGates } from '../scripts/token-eval/z0-gates.mjs';
import { NOT_RUN, bothCodings, firstApplyR, taskUnits } from '../scripts/token-eval/z0-hypotheses.mjs';
import { parseZ0Records } from '../scripts/token-eval/z0-records.mjs';
import { DEFAULTS, QUOTA_USD_PER_DAY, calibrate, parseArgs as parseSize, perRecordUsage, runCli as sizeCli, sizeZ0 } from '../scripts/token-eval/z0-size.mjs';
import { runCli as seedRuleCli, seedRule } from '../scripts/token-eval/z0-seed-rule.mjs';
import { GRADING, PRICES, PRICES_BY_MODEL, generate, jsonl, planOf, type Z0Record } from './fixtures/z0-gen.js';

vi.setConfig({ testTimeout: 180_000 });

const parse = (recs: readonly Z0Record[]) => parseZ0Records(jsonl(recs), 'runs.jsonl').records;
const STAT = { iterations: 200, seed: 1 };
const dirWith = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-r4-read-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
};
// Parsed records carry their file and line as a symbol key; two corpora written apart differ there, so compare the plain data.
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
// An off-pin file names the runs file it was written for, by its sha256.
const runsEntry = (runsText: string) => [{ dir: 'r1', file: 'runs.jsonl', sha256: createHash('sha256').update(runsText).digest('hex') }];
const withoutInputs = (json: string) => Object.fromEntries(Object.entries(JSON.parse(json)).filter(([k]) => k !== 'inputs'));

describe('a grading flip and an off-pin void against a drop list and hand-voided records', () => {
  const LESSON = 'rn-repo1-f1-L1';
  const BASE = generate();
  const cut = (r: Z0Record) => r.sequence === 'rn-repo2' && r.seed === 2 && r.position >= 9;
  const voidFile = JSON.stringify({ schema: 'z0-offpin/1', runs: runsEntry(jsonl(BASE.records)), voids: [{ sequence: 'rn-repo2', seed: 2, arm: 'A1', position: 9, sessionId: null, reason: 'cut-off attempt' }] });
  const common = { 'plan.json': JSON.stringify(BASE.plan), 'prices.json': JSON.stringify(PRICES) };
  const flipped = dirWith({ ...common, 'runs.jsonl': jsonl(BASE.records), 'grading.json': JSON.stringify({ ...GRADING, flippedLessons: [LESSON] }), 'off-pin.json': voidFile });
  const byHand = dirWith({
    ...common, 'runs.jsonl': jsonl(BASE.records.map((r) => (cut(r) ? { ...r, void: 'hand' } : r))),
    'drop-list.json': JSON.stringify({ droppedLessons: [LESSON], droppedFamilies: [] }),
  });
  const FLAGS = { flipped: ['--grading', 'grading.json', '--off-pin', 'off-pin.json'], byHand: ['--drop-list', 'drop-list.json'] };
  const input = (dir: string, flags: string[]) => loadInputs(parseAnalyze(['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', ...flags]), dir);

  it('has the lesson and the cut positions the comparison relies on', () => {
    expect(BASE.records.some((r) => r.lessons.some((l) => l.lessonId === LESSON))).toBe(true);
    expect(BASE.records.filter(cut).length).toBeGreaterThan(0);
  });

  it('gives analyze the same scored records both ways, fewer than with neither', () => {
    const scored = (dir: string, flags: string[]) => {
      const inputs = input(dir, flags);
      return analyzeZ0(inputs.records, { ...inputs, ...STAT }).filtered.scored;
    };
    const [a, b, none] = [scored(flipped, FLAGS.flipped), scored(byHand, FLAGS.byHand), scored(flipped, [])];
    expect(plain(a)).toEqual(plain(b));
    expect(a.length).toBeLessThan(none.length);
    expect(a.some((r: Z0Record) => cut(r) || r.lessons.some((l) => l.lessonId === LESSON))).toBe(false);
  });

  it('gives the size report and the seed rule the same figures both ways, and keeps the counts taken before filtering', () => {
    const sizeArgs = ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20', '--repos', '5', '--effects', '0.2', '--level-sims', '20'];
    const [sizeA, sizeB] = [sizeCli([...sizeArgs, ...FLAGS.flipped], flipped), sizeCli([...sizeArgs, ...FLAGS.byHand], byHand)];
    expect([sizeA.code, sizeA.stderr, sizeB.code, sizeB.stderr]).toEqual([0, '', 0, '']);
    expect(withoutInputs(sizeA.stdout)).toEqual(withoutInputs(sizeB.stdout));
    const calibration = JSON.parse(sizeA.stdout).calibration;
    expect(calibration.records).toBe(BASE.records.length);
    expect(calibration.perRecord).toEqual(JSON.parse(JSON.stringify(perRecordUsage(parse(BASE.records), PRICES))));
    expect(calibration.scored).toBe(BASE.records.length - BASE.records.filter(cut).length);
    // At --minimum-effect 0.25 H1 sizes below the cap; a count at the cap would be the same with or without the filter inputs.
    const ruleArgs = ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20', '--minimum-effect', '0.25'];
    const [ruleA, ruleB, ruleNone] = [seedRuleCli([...ruleArgs, ...FLAGS.flipped], flipped), seedRuleCli([...ruleArgs, ...FLAGS.byHand], byHand), seedRuleCli(ruleArgs, flipped)];
    expect([ruleA.code, ruleA.stderr, ruleB.code, ruleB.stderr, ruleNone.code, ruleNone.stderr]).toEqual([0, '', 0, '', 0, '']);
    const sized = JSON.parse(ruleA.stdout);
    expect(sized.perHypothesis.H1).toBeLessThan(sized.settings.cap);
    expect(withoutInputs(ruleA.stdout)).toEqual(withoutInputs(ruleB.stdout));
    expect(withoutInputs(ruleNone.stdout)).not.toEqual(withoutInputs(ruleB.stdout));
  });
});

describe('DESIGNS["r4-on-r3"] on a round 3 corpus with seed 4 and a dropped family', () => {
  const DESIGN = DESIGNS['r4-on-r3'];
  const [FAMILY, DROPPED] = ['rn-repo3-f2', 'hu3-f2'];
  const ARMS = ['A0', 'A1', 'A2', 'A4', 'A5'];
  const base = generate({ arms: ARMS });
  const clones = base.records.filter((r) => r.seed === 3 && ['A1', 'A2', 'A5'].includes(r.arm)).map((r) => ({ ...r, seed: 4, order: r.order + 1_000_000 }));
  const relabel = (r: Z0Record): Z0Record => (r.familyId === FAMILY ? { ...r, familyId: DROPPED } : r);
  const records = [...base.records, ...clones].map(relabel);
  const plan = planOf(records);
  const kept = records.filter((r) => r.seed <= 3 && r.familyId !== DROPPED);
  // A round 3 file whose claude-code row names the model, as the design prices by model.
  const R3_FILE = { asOf: '2026-11-01', 'claude-code': { ...PRICES['claude-code'], model: OPUS_MODEL } };
  const modern = filteredInput(parse(records), plan, { design: DESIGN }, { dropAbandoned: false });
  const classic = filteredInput(parse(kept), planOf(kept), {}, { dropAbandoned: false });

  it('scores the cells round 3 scores on the same records with seed 4 and the family removed', () => {
    expect(clones.length).toBeGreaterThan(0);
    expect(records.some((r) => r.familyId === DROPPED)).toBe(true);
    expect(plain(modern.filtered.scored)).toEqual(plain(classic.filtered.scored));
    expect(modern.filtered.scored.some((r: Z0Record) => r.seed > 3 || r.familyId === DROPPED)).toBe(false);
    expect(modern.records.some((r: Z0Record) => r.seed > 3)).toBe(false);
    expect(modern.planCells.some((c: { seed: number }) => c.seed > 3)).toBe(false);
  });

  it('drops the family once whether the design or a drop list names it', () => {
    const listed = filteredInput(parse(records), plan, { design: DESIGN, dropList: { droppedLessons: [], droppedFamilies: [DROPPED] } }, { dropAbandoned: false });
    expect(plain(listed.filtered.scored)).toEqual(plain(modern.filtered.scored));
    const opts = filterOpts({ design: DESIGN, dropList: { droppedLessons: [], droppedFamilies: [DROPPED] } });
    expect(opts.dropList.droppedFamilies).toEqual([DROPPED, ...DESIGN.dropFamilies.filter((f: string) => f !== DROPPED)]);
  });

  it('gives the same task units and both codings as round 3, priced by model from round 3\'s file', () => {
    const a = taskUnits(modern.filtered.scored, 'A2', 'A1', R3_FILE, firstApplyR, { design: DESIGN });
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(taskUnits(classic.filtered.scored, 'A2', 'A1', PRICES, firstApplyR));
    expect(bothCodings(modern.filtered.scored, 'A2', 'A1', { ...STAT, design: DESIGN }, firstApplyR)).toEqual(bothCodings(classic.filtered.scored, 'A2', 'A1', STAT, firstApplyR));
  });

  it('holds no seed 4 record in the gates or the planned runs of G3, and the sizer stops on T2a until part B sizes it', () => {
    const gates = computeGates(modern.records, modern.filtered, GRADING, { ...STAT, design: DESIGN });
    const round3 = computeGates(classic.records, classic.filtered, GRADING, STAT);
    expect(gates.G3.plannedRuns).toBe(round3.G3.plannedRuns);
    expect(gates.G2).toEqual({ pass: true, claudeCode: { status: NOT_RUN, required: false, pass: true }, codex: { status: NOT_RUN, required: false, pass: true } });
    expect(gates.pass).toBe(true);
    const args = parseSize(['--runs', 'r', '--plan', 'p', '--prices', 'c', '--sims', '20', '--repos', '5', '--effects', '0.2', '--level-sims', '20']);
    const quota = Object.fromEntries(Object.entries(QUOTA_USD_PER_DAY).map(([tool, usdPerDay]) => [tool, { usdPerDay, source: 'default assumption' }]));
    const settings = { ...Object.fromEntries(Object.entries(args).filter(([k]) => k in DEFAULTS)), firstWave: 3, holmLevel: 0.025, quota };
    expect(() => sizeZ0(parse(records), plan, R3_FILE, { ...settings, ...filterOpts({ design: DESIGN }) })).toThrow(/^T2a: design r4-on-r3 names it in its seed rule, but the rule sizes only H1, H2, T1, T3, H4; part B sizes T2a with its own rule$/);
    const cal = calibrate(modern.filtered, R3_FILE, 0.8, { design: DESIGN });
    expect(cal.H1).toEqual({ reason: 'design r4-on-r3 has no H1' });
    expect(cal.H4).toEqual(calibrate(classic.filtered, PRICES, 0.8).H4);
  });

  it('analyzes to a valid blind status with nothing left unplanned', () => {
    const a = analyzeZ0(parse(records), { planCells: plan, design: DESIGN, prices: R3_FILE, grading: GRADING, ...STAT });
    expect([a.status, a.unplanned]).toEqual(['valid', []]);
  });
});

describe('loadInputs and the three CLIs', () => {
  const g = generate({ repos: 2, arms: ['A0', 'A1', 'A2', 'A4', 'A5'] });
  const files = (extra: Record<string, string> = {}) => dirWith({ 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), ...extra });
  interface Entry { runs: string[]; plan: string[]; offPin: string[]; prices: string | null; grading: string | null; dropList: string | null; out: string | null }
  const entry = (extra: Partial<Entry>): Entry => ({ runs: ['runs.jsonl'], plan: ['plan.json'], offPin: [], prices: null, grading: null, dropList: null, out: null, ...extra });
  const offPin = (v: { sequence: string; seed: number; position: number }, runs = runsEntry(jsonl(g.records))) => JSON.stringify({ schema: 'z0-offpin/1', runs, voids: [{ arm: 'A1', sessionId: null, reason: 'cut', ...v }] });

  it('returns prices null when no price file is given, and reads none', () => {
    const dir = files();
    const inputs = loadInputs(entry({}), dir);
    expect([inputs.prices, inputs.records.length, inputs.voids]).toEqual([null, g.records.length, []]);
  });

  it('joins the voids of two --off-pin files, each tagged with its own file', () => {
    const dir = files({ 'a.json': offPin({ sequence: 'rn-repo1', seed: 1, position: 4 }), 'b.json': offPin({ sequence: 'rn-repo2', seed: 2, position: 9 }) });
    const inputs = loadInputs(entry({ offPin: ['a.json', 'b.json'] }), dir);
    expect(inputs.voids.map((v: { file: string; sequence: string }) => [v.file, v.sequence])).toEqual([['a.json', 'rn-repo1'], ['b.json', 'rn-repo2']]);
    const analysis = analyzeZ0(inputs.records, { ...inputs, ...STAT });
    expect(analysis.filtered.offPinVoided.positions).toBe(14 + 9);
  });

  it('stops on an off-pin file with a void and an empty runs list, naming the file', () => {
    const dir = files({ 'empty.json': offPin({ sequence: 'rn-repo1', seed: 1, position: 4 }, []) });
    expect(() => loadInputs(entry({ offPin: ['empty.json'] }), dir)).toThrow(/empty\.json: it lists voids but its runs is empty/);
  });

  it('hashes the runs files for the off-pin binding only when an --off-pin file is given', () => {
    const dir = files({ 'a.json': offPin({ sequence: 'rn-repo1', seed: 1, position: 4 }) });
    const hashed = vi.spyOn(blind, 'sha256');
    try {
      loadInputs(entry({}), dir);
      expect(hashed).not.toHaveBeenCalled();
      loadInputs(entry({ offPin: ['a.json'] }), dir);
      expect(hashed).toHaveBeenCalledTimes(1);
    } finally {
      hashed.mockRestore();
    }
  });

  it('exits 1 with the message and writes no blind key when hashing the inputs fails', () => {
    const dir = files({ 'prices.json': JSON.stringify(PRICES) });
    const argv = ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json'];
    const hashes = vi.spyOn(blind, 'inputHashes').mockImplementationOnce(() => { throw new Error('cannot read src/eval/eval-stats.ts'); });
    const failed = analyzeCli(argv, dir);
    hashes.mockRestore();
    expect([failed.code, failed.stdout, failed.stderr]).toEqual([1, '', 'cannot read src/eval/eval-stats.ts\n']);
    expect(fs.existsSync(path.join(dir, 'z0-blind-key.json'))).toBe(false);
    expect(analyzeCli(argv, dir).code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'z0-blind-key.json'))).toBe(true);
  });

  it('exits 1 with the usage in each CLI when --prices is missing', () => {
    const dir = files();
    const argv = ['--runs', 'runs.jsonl', '--plan', 'plan.json'];
    for (const [name, cli] of [['z0-analyze', analyzeCli], ['z0-size', sizeCli], ['z0-seed-rule', seedRuleCli]] as const) {
      const r = cli(argv, dir);
      expect([name, r.code, r.stdout]).toEqual([name, 1, '']);
      expect(r.stderr, name).toContain(`usage: ${name}.mjs`);
    }
  });
});

describe('the seed rule on a design with a test it cannot size', () => {
  const SETTINGS = { minimumEffect: 0.15, targetZ: 3.5, cap: 9, onMiss: 'cap', power: 0.8, sims: 20, seed: 1, bound: 0.8, firstWave: 3 };

  it('stops under r4 on the first T2 part, naming it and saying part B sizes it', () => {
    const g = generate({ design: DESIGNS.r4 });
    expect(() => seedRule(parse(g.records), g.plan, PRICES_BY_MODEL, { ...SETTINGS, design: DESIGNS.r4 })).toThrow(/^T2a: design r4 names it in its seed rule, but the rule sizes only H1, H2, T1, T3, H4; part B sizes T2a with its own rule$/);
  });

  it('stops under r4-on-r3 on the first T2 part of its one group, naming it and saying part B sizes it', () => {
    const g = generate({ arms: ['A0', 'A1', 'A2', 'A4', 'A5'] });
    expect(() => seedRule(parse(g.records), g.plan, PRICES, { ...SETTINGS, design: DESIGNS['r4-on-r3'] })).toThrow(/^T2a: design r4-on-r3 names it in its seed rule, but the rule sizes only H1, H2, T1, T3, H4; part B sizes T2a with its own rule$/);
  });
});

describe('the sizer on a design with a test it cannot size', () => {
  const settings = () => {
    const args = parseSize(['--runs', 'r', '--plan', 'p', '--prices', 'c', '--sims', '20', '--repos', '5', '--effects', '0.2', '--level-sims', '20']);
    const quota = Object.fromEntries(Object.entries(QUOTA_USD_PER_DAY).map(([tool, usdPerDay]) => [tool, { usdPerDay, source: 'default assumption' }]));
    return { ...Object.fromEntries(Object.entries(args).filter(([k]) => k in DEFAULTS)), firstWave: 3, holmLevel: 0.025, quota };
  };

  it('stops under r4 on the first T2 part, as the seed rule does, rather than sizing it at H1\'s search', () => {
    const g = generate({ design: DESIGNS.r4 });
    const opts = { ...settings(), ...filterOpts({ design: DESIGNS.r4 }), design: DESIGNS.r4 };
    expect(() => sizeZ0(parse(g.records), g.plan, PRICES_BY_MODEL, opts)).toThrow(/^T2a: design r4 names it in its seed rule, but the rule sizes only H1, H2, T1, T3, H4; part B sizes T2a with its own rule$/);
  });
});
