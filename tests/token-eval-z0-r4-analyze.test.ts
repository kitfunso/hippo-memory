// Round 4 slice 4b: the analyzer's round 4 path (inputs, gate wiring, windows, scoring, headlines, drift, publish list).
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import * as analyze from '../scripts/token-eval/z0-analyze.mjs';
import * as filters from '../scripts/token-eval/z0-filters.mjs';
import * as hyp from '../scripts/token-eval/z0-hypotheses.mjs';
import { scoreTest } from '../scripts/token-eval/z0-verdict-r4.mjs';
import { MERGE_SCHEMA, OFFPIN_SCHEMA } from '../scripts/token-eval/z0-records.mjs';
import { GRADING, PRICES, PRICES_BY_MODEL, generate, jsonl, type Generated, type Z0Record } from './fixtures/z0-gen.js';
const { FILTER_KEYS, filteredInput } = filters;
import { KEYS, PINS, R3, R4, R4_ARGV, SPEND, STAT, TESTS, WIN, cells, cleanUp, corpus, drift, driftOf, levelsFile, levelsOf, loose, parse, raise, readInputs, seedRule, workspace } from './fixtures/z0-r4-read.js';

vi.setConfig({ testTimeout: 60_000 });
afterAll(cleanUp);

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const run = (g: Generated, over: any = {}) => loose(analyze.analyzeZ0(parse(g.records), readInputs(g, over)));
const report = (a: any) => analyze.buildReport(a, { warnings: [], grading: GRADING }, STAT, null, []);
const text = (a: any) => analyze.renderText(report(a), R4);
const lines = (t: string) => t.split('\n');
const key = (a: { filtered: { arms: string[] } }) => Object.fromEntries(a.filtered.arms.map((arm, i) => [arm, `K${i + 1}`]));
/** The report text a read prints at the gates, blind so a gate run with no unblinding still renders. */
const gateText = (a: ReturnType<typeof loose>, design = R3) => analyze.renderText(analyze.buildReport(a, { warnings: [], grading: GRADING }, STAT, key(a), []), design);

describe('filteredInput maxSeed (brief 4)', () => {
  const g = raise(corpus(), 6);
  const voids = [{ sequence: 'rn-repo1', seed: 6, arm: 'S1', position: 3, sessionId: null, reason: 'cut', file: 'off.json', index: 0 }];
  const read = (opts: any) => loose(filteredInput(parse(g.records), cells(g), { design: R4, ...opts }, { dropAbandoned: false }));
  const seeds = (xs: { seed: number }[]) => Math.max(...xs.map((x) => x.seed));

  it('drops records, plan cells and voids above opts.maxSeed, and keeps them when it is null or missing', () => {
    const [none, capped, nulled] = [read({ voids }), read({ voids, maxSeed: 5 }), read({ voids, maxSeed: null })];
    expect([seeds(none.records), seeds(none.planCells), none.filtered.offPinVoided.positions > 0]).toEqual([6, 6, true]);
    expect([seeds(capped.records), seeds(capped.planCells), capped.filtered.offPinVoided.positions]).toEqual([5, 5, 0]);
    expect(nulled.records.length).toBe(none.records.length);
  });

  it('takes the lower of opts.maxSeed and the design maxSeed, and leaves FILTER_KEYS alone', () => {
    const r4On3 = DESIGNS['r4-on-r3'];
    const old = raise(generate({ arms: ['A0', 'A1', 'A2', 'A4', 'A5'], repos: 2 }), 6);
    const at = (opts: any) => loose(filteredInput(parse(old.records), cells(old), { design: r4On3, ...opts }, { dropAbandoned: false }));
    expect([seeds(at({ maxSeed: 5 }).records), seeds(at({ maxSeed: 2 }).records), seeds(at({}).records)]).toEqual([3, 2, 3]);
    expect(FILTER_KEYS).toEqual(['grading', 'dropList', 'voids', 'design']);
  });

  it('names design r4 in a stray-arm error at the cap [IO3]', () => {
    const stray = raise(corpus(), 6);
    stray.records.push({ ...structuredClone(stray.records.find((r) => r.arm === 'S1')!), arm: 'A1' });
    stray.plan = loose(stray.records).map((r: Z0Record) => ({ sequence: r.sequence, seed: r.seed, position: r.position, arm: r.arm, set: r.set, kind: r.kind, familyId: r.familyId, taskId: r.taskId, repo: r.repo }));
    expect(() => filteredInput(parse(stray.records), cells(stray), { design: R4, maxSeed: 5 }, { dropAbandoned: false })).toThrow(/arm A1 is not in design r4/);
  });
});

describe('parseArgs flag rules (brief 10)', () => {
  const parse1 = (...argv: string[]) => () => analyze.parseArgs(argv);
  const R3_BASE = ['--runs', 'r.jsonl', '--plan', 'p.json', '--prices', 'pr.json'];

  it('starts every new key at null or empty and keeps the usage prefix', () => {
    const args = loose(analyze.parseArgs(R3_BASE));
    expect([args.design, args.readSet, args.seedRule, args.pins, args.mergeManifest, args.levels, args.driftRuns, args.driftPlan, args.ledgerRuns]).toEqual([null, null, null, null, [], [], [], [], []]);
    expect(parse1('--runs', 'r.jsonl')).toThrow(/^usage: z0-analyze\.mjs --runs FILE/);
  });

  it('refuses each round 4 flag under round 3 and keeps --off-pin and --merge-manifest legal', () => {
    for (const flag of ['--read-set', '--levels', '--seed-rule', '--pins', '--drift-runs', '--drift-plan', '--ledger-runs']) {
      expect(parse1(...R3_BASE, flag, 'x'), flag).toThrow(`${flag} is round 4 only; pass --design r4`);
      expect(parse1('--design', 'r3', ...R3_BASE, flag, 'x'), flag).toThrow(`${flag} is round 4 only; pass --design r4`);
    }
    expect(loose(analyze.parseArgs([...R3_BASE, '--off-pin', 'o.json', '--merge-manifest', 'm.json'])).mergeManifest).toEqual(['m.json']);
  });

  it('takes --design r3 or r4 only', () => {
    expect(parse1('--design', 'r5', ...R3_BASE)).toThrow(/--design/);
    expect(parse1('--design', 'r4-on-r3', ...R3_BASE)).toThrow(/--design/);
  });

  it('wants, under r4, the runs and plan or a read set, two levels files and every round 4 input', () => {
    expect(loose(analyze.parseArgs(R4_ARGV)).levels).toEqual(['pre.json', 'b1.json']);
    expect(loose(analyze.parseArgs(['--design', 'r4', '--read-set', 'rs.txt', '--prices', 'pr.json', ...R4_ARGV.slice(R4_ARGV.indexOf('--levels'))])).readSet).toBe('rs.txt');
    expect(parse1('--design', 'r4', '--prices', 'pr.json', ...R4_ARGV.slice(R4_ARGV.indexOf('--levels')))).toThrow(/--runs and --plan, or --read-set/);
    const files = R4_ARGV.slice(R4_ARGV.indexOf('--levels'));
    const without = (flag: string) => { const at = files.indexOf(flag); return [...files.slice(0, at), ...files.slice(at + 2)]; };
    const head = ['--design', 'r4', '--runs', 'r.jsonl', '--plan', 'p.json', '--prices', 'pr.json'];
    for (const flag of ['--seed-rule', '--pins', '--drift-runs', '--drift-plan']) expect(parse1(...head, ...without(flag)), flag).toThrow(`a round 4 read needs ${flag}`);
    const stop = 'each test keeps the lower of its two levels (prereg Level check); pass the pre-freeze and the batch 1 levels files';
    for (const given of [[], ['--levels', 'a.json'], ['--levels', 'a.json', '--levels', 'b.json', '--levels', 'c.json']]) {
      expect(parse1(...head, ...given, '--seed-rule', 's', '--pins', 'p', '--drift-runs', 'd', '--drift-plan', 'e'), String(given.length)).toThrow(stop);
    }
  });

  it('wants --ledger-runs with --unblind and refuses it without', () => {
    expect(parse1(...R4_ARGV, '--unblind')).toThrow('a round 4 read needs --ledger-runs');
    expect(parse1(...R4_ARGV, '--ledger-runs', 'out1')).toThrow('--ledger-runs needs --unblind; spend by arm opens the arm codes');
    expect(loose(analyze.parseArgs([...R4_ARGV, '--unblind', '--ledger-runs', 'out1', '--ledger-runs', 'out2'])).ledgerRuns).toEqual(['out1', 'out2']);
  });

  it('exits 1 on an empty or trailing value, naming the flag', () => {
    for (const flag of ['--pins', '--design', '--read-set', '--levels', '--prices']) {
      expect(parse1(...R4_ARGV, flag, ''), flag).toThrow(`${flag} needs a value`);
      expect(parse1(...R4_ARGV, flag), flag).toThrow(`${flag} needs a value`);
    }
  });
});

describe('gate wiring through analyzeZ0 from loadInputs [S3A-R7, W2-2]', () => {
  const g = generate();
  const runsText = jsonl(g.records);
  const void0 = (sequence: string) => ({ sequence, seed: 1, arm: 'A1', position: 0, sessionId: null, reason: 'cut' });
  const offPin = (voids: object[]) => JSON.stringify({ schema: OFFPIN_SCHEMA, runs: [{ dir: 'r', file: 'runs.jsonl', sha256: sha(runsText) }], voids });
  const manifest = (leaked: number) => JSON.stringify({ schema: MERGE_SCHEMA, first: { dir: 'r', file: 'runs.jsonl', sha256: 'x' }, hashes: [], droppedSeeds: {}, firstRun: { plannedSequenceSeeds: 36, leakedSequenceSeeds: leaked } });
  const r3Dir = (over: Record<string, string>) => {
    const dir = workspace(g, { 'runs.jsonl': runsText, 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES), ...over });
    return { dir, load: (...flags: string[]) => loose(analyze.loadInputs(analyze.parseArgs(['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--grading', 'grading.json', ...flags]), dir)) };
  };
  const read = (inputs: ReturnType<typeof loose>, design = R3) => loose(analyze.analyzeZ0(inputs.records, { ...inputs, ...STAT, design }));

  it('fails G1 and prints the 5% bar when off-pin voids pass 5% of planned positions, and moves nothing without --off-pin', () => {
    const { load } = r3Dir({ 'off.json': offPin([void0('rn-repo1'), void0('rn-repo2')]) });
    const [over, plain] = [read(load('--off-pin', 'off.json')), read(load())];
    expect([over.gates.G1.pass, over.gates.G1.offPinPass, over.gates.G1.offPinVoided.share > 0.05, over.gates.failed]).toEqual([false, false, true, ['G1']]);
    expect(gateText(over)).toMatch(/^G1 fail: .*; off-pin voided 36 positions \(\d+\.\d%\), over the 5% bar$/m);
    expect(Object.keys(plain.gates.G1)).toEqual(['pass', 'operatorCanaries', 'envKeysOutside', 'anthropicApiKeyRecords', 'perArm']);
    expect(Object.keys(plain.gates.G3)).toEqual(['pass', 'leaked', 'plannedRuns', 'share']);
    expect(gateText(plain)).not.toMatch(/off-pin|first run/);
  });

  it('prints "within the 5% bar" for a small void and keeps the line as today without the flag', () => {
    const { load } = r3Dir({ 'ok.json': offPin([{ ...void0('rn-repo1'), position: 14 }]) });
    const a = read(load('--off-pin', 'ok.json'));
    expect([a.gates.G1.pass, a.gates.G1.offPinVoided.positions]).toEqual([true, 4]);
    expect(gateText(a)).toMatch(/off-pin voided 4 positions \(\d+\.\d%\), within the 5% bar$/m);
  });

  it('carries the first-run count into G3 from every --merge-manifest, in r3 and r4, and moves no pass', () => {
    const { load } = r3Dir({ 'm1.json': manifest(1), 'm2.json': manifest(2) });
    const a = read(load('--merge-manifest', 'm1.json', '--merge-manifest', 'm2.json'));
    expect(a.gates.G3.firstRun).toEqual({ leakedSequenceSeeds: 3, plannedRuns: a.filtered.plannedRuns });
    expect(a.gates.G3.pass).toBe(read(load()).gates.G3.pass);
    expect(gateText(a)).toMatch(new RegExp(`^G3 pass: 0 of ${a.filtered.plannedRuns} planned \\(sequence, seed\\)s leaked; first run 3 of ${a.filtered.plannedRuns} leaked$`, 'm'));
    const r4 = corpus();
    const dir = workspace(r4, { 'm1.json': manifest(2) });
    const inputs = loose(analyze.loadAnalyzeInputs(analyze.parseArgs([...R4_ARGV, '--merge-manifest', 'm1.json']), dir));
    const b = loose(analyze.analyzeZ0(inputs.records, { ...inputs, ...STAT }));
    expect([b.gates.G3.firstRun.leakedSequenceSeeds, b.gates.G1.offPinPass, b.gates.pass]).toEqual([2, true, true]);
  });

  it('returns offPinGiven, mergeManifests and maxSeed from loadInputs for every design', () => {
    const { load } = r3Dir({ 'm1.json': manifest(1), 'ok.json': offPin([]) });
    const inputs = load('--off-pin', 'ok.json', '--merge-manifest', 'm1.json');
    expect([inputs.offPinGiven, inputs.mergeManifests.length, inputs.maxSeed, load().offPinGiven, load().mergeManifests]).toEqual([true, 1, null, false, []]);
    expect(loose(analyze.loadInputs({ runs: ['runs.jsonl'], plan: ['plan.json'], offPin: [], prices: null, grading: null, dropList: null, out: null }, workspace(g))).maxSeed).toBeNull();
  });
});

describe('--read-set expands to the flags written out (brief 3)', () => {
  const g = corpus();
  const bySeq = (keep: (s: string) => boolean) => ({ records: g.records.filter((r) => keep(r.sequence)), plan: g.plan.filter((c) => keep(c.sequence)) });
  const parts = [bySeq((s) => KEYS.slice(0, 2).includes(s)), bySeq((s) => KEYS.slice(2).includes(s))];
  const manifest = JSON.stringify({ schema: MERGE_SCHEMA, first: { dir: 'm', file: 'runs.jsonl', sha256: 'x' }, hashes: [], droppedSeeds: {}, firstRun: { plannedSequenceSeeds: 9, leakedSequenceSeeds: 2 } });
  const offPin = (records: Z0Record[]) => JSON.stringify({ schema: OFFPIN_SCHEMA, runs: [{ dir: 'x', file: 'runs.jsonl', sha256: sha(jsonl(records)) }], voids: [] });
  const dir = workspace(g, { 'm.json': manifest });
  for (const [i, p] of parts.entries()) {
    fs.mkdirSync(path.join(dir, `p${i}`));
    for (const [name, body] of Object.entries({ 'runs.jsonl': jsonl(p.records), 'plan.json': JSON.stringify(p.plan), 'off-pin.json': offPin(p.records) })) fs.writeFileSync(path.join(dir, `p${i}`, name), body);
  }
  const set = (extra: string[] = []) => {
    fs.writeFileSync(path.join(dir, 'rs.txt'), [...extra, ...parts.map((_, i) => `--runs p${i}/runs.jsonl --plan p${i}/plan.json --off-pin p${i}/off-pin.json`), '--merge-manifest m.json'].join('\n') + '\n');
    return ['--design', 'r4', '--prices', 'prices.json', '--grading', 'grading.json', ...R4_ARGV.slice(R4_ARGV.indexOf('--levels')), '--out'];
  };

  it('gives the same report as the flags, hash file paths aside, resolving a relative path against cwd', () => {
    const rsArgs = set(['--max-seed 9']);
    const flagArgs = ['--runs', 'p0/runs.jsonl', '--plan', 'p0/plan.json', '--off-pin', 'p0/off-pin.json', '--runs', 'p1/runs.jsonl', '--plan', 'p1/plan.json', '--off-pin', 'p1/off-pin.json', '--merge-manifest', 'm.json'];
    const [a, b] = [analyze.runCli([...rsArgs, 'a.json', '--read-set', 'rs.txt'], dir), analyze.runCli([...rsArgs, 'b.json', ...flagArgs], dir)];
    expect([a.code, a.stderr, b.code, b.stderr]).toEqual([0, '', 0, '']);
    const [ra, rb] = ['a.json', 'b.json'].map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect({ ...ra, hashes: 0 }).toEqual({ ...rb, hashes: 0 });
    expect(ra.gates.G3.firstRun.leakedSequenceSeeds).toBe(2);
    expect(ra.hashes.filter((h: { role: string }) => ['read-set', 'merge-manifest', 'runs', 'off-pin'].includes(h.role)).map((h: { role: string }) => h.role)).toEqual(['runs', 'runs', 'off-pin', 'off-pin', 'read-set', 'merge-manifest']);
  });

  it('expandReadSet appends the pairs, a manifest-only line adds that alone, and --max-seed sets maxSeed', () => {
    set(['--max-seed 5']);
    const args = loose(analyze.parseArgs(['--design', 'r4', '--read-set', 'rs.txt', '--prices', 'prices.json', ...R4_ARGV.slice(R4_ARGV.indexOf('--levels'))]));
    const out = loose(analyze.expandReadSet(args, dir));
    expect([out.runs, out.plan.length, out.offPin.length, out.mergeManifest, out.maxSeed]).toEqual([['p0/runs.jsonl', 'p1/runs.jsonl'], 2, 2, ['m.json'], 5]);
    expect([args.runs, args.maxSeed ?? null]).toEqual([[], null]);
    set();
    expect(loose(analyze.expandReadSet(args, dir)).maxSeed).toBeNull();
  });

  it('exits 1 naming the read set when it leaves no runs file', () => {
    fs.writeFileSync(path.join(dir, 'only.txt'), '--merge-manifest m.json\n');
    const r = analyze.runCli(['--design', 'r4', '--read-set', 'only.txt', '--prices', 'prices.json', ...R4_ARGV.slice(R4_ARGV.indexOf('--levels'))], dir);
    expect([r.code, r.stderr]).toEqual([1, expect.stringContaining('only.txt')]);
  });
});

describe('seed windows (brief 7)', () => {
  const g = raise(corpus(), 6, (r, seed) => r.sequence === KEYS[0] || seed <= 5);
  const windows = (n: Record<string, number>, plan = cells(g)) => loose(analyze.seedWindows(plan, R4, seedRule(3, Object.fromEntries(Object.entries(n).map(([t, seeds]) => [t, { seeds }]))), KEYS));

  it('reaches a test when every repository has both arms at every seed up to its count, and reads k as the highest such seed', () => {
    const w = windows({ T1: 5, T3: 6, T2a: 3 });
    expect([w.T1.k, w.T1.reached, w.T3.k, w.T3.reached, w.T2a.reached]).toEqual([5, true, 5, false, true]);
    expect(w.T1).toMatchObject({ n: 5, branch: 'rule', power: null });
    expect(windows({}, cells(corpus())).T1).toMatchObject({ n: 3, k: 3, reached: true });
  });

  it('counts a seed missing in one repository against every test that needs it', () => {
    const gap = corpus();
    const plan = cells(gap).filter((c: { sequence: string; seed: number; arm: string }) => !(c.sequence === KEYS[1] && c.seed === 3 && c.arm === 'S2'));
    expect(windows({}, plan).T1).toMatchObject({ k: 2, reached: false });
  });

  it('reads a read-set cap through analyzeZ0: a count above it enters at p = 1 with its line, no seed above the cap is read, a count at it gets its verdict [GO2]', () => {
    const a = run(g, { maxSeed: 5, seedRule: seedRule(3, { T1: { seeds: 5 }, T3: { seeds: 6 } }) });
    expect(a.filtered.scored.every((r: Z0Record) => r.seed <= 5)).toBe(true);
    expect(a.hypotheses.windows.T3).toMatchObject({ n: 6, k: 5, reached: false });
    expect([a.hypotheses.scored.closed.T1.verdict, a.hypotheses.scored.closed.T3.verdict]).toEqual(['win', 'no verdict']);
    expect(text(a)).toContain('T3 at seeds 1 to 5, below its count 6: no verdict');
    expect(text(a)).toMatch(/^T3 at seeds 1 to 5, below its count 6: no verdict; estimate at seeds 1 to 5: violation -?[\d.]+ \[[^\n]*excluded /m);
    expect(a.hypotheses.estimates.T3.violation.estimate).toEqual(expect.any(Number));
  });

  it('gives T3 no verdict when the run is cut below its count and leaves T2 at its own level at 0.025', () => {
    const slow = corpus({ knobs: { ...loose({ O1: { fail: 0.5, resolve: 0.8 }, S1: { fail: 0.5 }, S2: { fail: 0.1, resolve: 1, cost: 4 }, S5: { fail: 0.5 } }) } });
    const a = run(raise(slow, 5), { maxSeed: 4, seedRule: seedRule(3, { T3: { seeds: 5 } }) });
    const closed = a.hypotheses.scored.closed;
    expect([closed.T1.verdict, closed.T3.verdict, closed.T2.verdict, closed.T2.readAt]).toEqual(['win', 'no verdict', 'no pass', '0.025']);
  });

  it('prints the branch and power of a miss or cap test', () => {
    const a = run(corpus(), { seedRule: seedRule(3, { T2a: { branch: 'miss', power: 0.7 }, H4: { branch: 'cap', power: 0.55 } }) });
    expect(text(a)).toMatch(/^T2a ran at 3 seeds by the miss branch; power 0\.700$/m);
    expect(text(a)).toMatch(/^H4 ran at 3 seeds by the cap branch; power 0\.550$/m);
  });
});

describe('estimates below a count and with T1 not won (fix round 1, items 1 and 2)', () => {
  const g = corpus();
  const below = (test: string) => run(g, { seedRule: seedRule(3, { [test]: { seeds: 5 } }) });
  const ESTIMATE = '; estimate at seeds 1 to 3: ';
  const CI = String.raw`-?[\d.]+ \[[^\]]*\] t\([\d.]+\)`;

  it('computes a test below its count at seeds 1 to k, as the read at k gives it, and still enters it at p = 1 with no verdict', () => {
    const [full, cut] = [run(g), below('T3')];
    expect(JSON.stringify(cut.hypotheses.estimates.T3)).toBe(JSON.stringify(full.hypotheses.estimates.T3));
    expect(cut.hypotheses.windows.T3).toMatchObject({ n: 5, k: 3, reached: false });
    expect([cut.hypotheses.scored.closed.T3.verdict, cut.hypotheses.scored.views.T3, cut.hypotheses.scored.seen.T3 === null]).toEqual(['no verdict', null, false]);
  });

  it.each([
    ['T1', new RegExp(String.raw`^violation ${CI}, excluded ${CI}$`)],
    ['T3', new RegExp(String.raw`^violation ${CI}, excluded ${CI}`)],
    ['T2a', new RegExp(String.raw`^R [\d.]+ \[[^\]]*\] t\([\d.]+\), bootstrap \[[^\]]*\]$`)],
    ['T2b', new RegExp(String.raw`^resolve difference ${CI}$`)],
    ['T2c', new RegExp(String.raw`^repeat difference violation ${CI}, excluded ${CI}$`)],
    ['H4', /^(pass|FAIL): /],
  ])('prints the estimate of %s on its below-count line, marked as at seeds 1 to k', (test, tail) => {
    const line = lines(text(below(test))).find((l) => l.startsWith(`${test} at seeds`));
    expect(line).toContain(`${test} at seeds 1 to 3, below its count 5: no verdict${ESTIMATE}`);
    expect(line!.split(ESTIMATE)[1]).toMatch(tail);
  });

  it('prints the T2 parts and T3 with their estimates and intervals, marked no verdict, when T1 does not win', () => {
    const out = text(run(g, { levels: levelsOf(1e-9) }));
    const part = String.raw`a R [\d.]+ \[[^\]]*\] t\([\d.]+\), bootstrap \[[^\]]*\]; b resolve difference ${CI}; c repeat difference violation ${CI}, excluded ${CI}`;
    expect(out).toMatch(new RegExp(String.raw`^T2 no verdict \(T1 is \w+\); estimates at 0\.025: ${part}$`, 'm'));
    expect(out).toMatch(new RegExp(String.raw`^T3 no verdict \(T1 is \w+\); estimate at 0\.025: violation ${CI}, excluded ${CI}$`, 'm'));
    expect(lines(out).find((l) => l.startsWith('T2 '))).not.toMatch(/\((win|no win)/);
    expect(out).not.toContain(hyp.LESSONS_SENTENCE);
    expect(out).not.toContain(hyp.BEHAVIOUR_SENTENCE);
  });
});

describe('scoreR4 with hand-made numbers (brief 8)', () => {
  const stat = (estimate: number, se = 0.01, df = 20) => ({ estimate, se, df });
  const codes = (estimate: number, se = 0.01, df = 20) => ({ violation: stat(estimate, se, df), excluded: stat(estimate, se, df) });
  const hand = (over: any = {}) => ({
    T1: codes(-0.3), T3: codes(-0.2), T2a: { ...stat(Math.log(0.5)), ratio: 0.5 }, T2b: stat(0.01), T2c: codes(-0.1),
    s1: { a: { ...stat(Math.log(0.55)), ratio: 0.55 }, b: stat(0.01), c: codes(-0.05) }, ...over,
  });
  const WINDOWS = Object.fromEntries(TESTS.map((t) => [t, { n: 3, k: 3, reached: true, branch: 'rule', power: null }]));
  const score = (over: any = {}, levels = levelsOf(0.05), windows = WINDOWS) => loose(analyze.scoreR4(hand(over), levels, windows));

  it('opens T2 and T3 when T1 wins, and reads T2 at 0.05 once the joint null falls', () => {
    const s = score();
    expect([s.closed.T1.verdict, s.closed.T2.verdict, s.closed.T2.readAt, s.closed.T3.verdict, s.closed.jointFalls]).toEqual(['win', 'pass', '0.05', 'win', true]);
    expect(s.closed.T2.p).toBeLessThan(0.001);
  });

  it('wins T2b at -0.02 with a small error, and not at -0.04, however small its p [CP2-2]', () => {
    const [up, down] = [score({ T2b: stat(-0.02, 0.004) }), score({ T2b: stat(-0.04, 0.004) })];
    expect([up.closed.T2.verdict, up.closed.T2.parts.b.win['0.05']]).toEqual(['pass', true]);
    expect([down.closed.T2.verdict, down.closed.T2.parts.b.win['0.05'], down.closed.T2.parts.b.harmfulSide]).toEqual(['no pass', false, true]);
  });

  it('marks a win whose rounded-df interval crosses the null as a knife edge [GO6]', () => {
    const spec = { nullValue: 0, side: 'below', level: 0.05 };
    let [lo, hi] = [0, 6];
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (scoreTest({ estimate: -mid, se: 1, df: 7.3454 }, spec).p < 0.05) hi = mid;
      else lo = mid;
    }
    const edge = score({ T1: codes(-hi, 1, 7.3454) });
    expect([edge.closed.T1.verdict, edge.edges.T1]).toEqual(['win', true]);
    const lines = analyze.testLinesR4(R4, edge, WINDOWS).join('\n');
    expect(lines).toMatch(/^T1 win.*\(knife edge: a bound crosses the null\)/m);
    expect(analyze.testLinesR4(R4, score(), WINDOWS).join('\n')).not.toContain('knife edge');
  });

  it('gives T1 no verdict, and so T2 and T3 none, when it is unreached or has no estimate', () => {
    const cut = { ...WINDOWS, T1: { n: 5, k: 3, reached: false, branch: 'rule', power: null } };
    for (const s of [score({}, levelsOf(0.05), cut), score({ T1: null })]) expect([s.closed.T1.verdict, s.closed.T2.verdict, s.closed.T3.verdict]).toEqual(['no verdict', 'no verdict', 'no verdict']);
    expect(analyze.testLinesR4(R4, score({}, levelsOf(0.05), cut), cut).join('\n')).toContain('T1 at seeds 1 to 3, below its count 5: no verdict; estimate at seeds 1 to 3: violation -0.300 [');
  });

  it('keeps T2 at no pass when part (a) has no estimate, and enters an unreached part as no verdict', () => {
    expect(score({ T2a: { estimate: null, reason: '0 solves' } }).closed.T2.verdict).toBe('no pass');
    const cut = { ...WINDOWS, T2c: { n: 5, k: 3, reached: false, branch: 'rule', power: null } };
    const s = score({}, levelsOf(0.05), cut);
    expect([s.closed.T2.verdict, s.views.T2.c]).toEqual(['no pass', null]);
  });

  it('reads S1 at the level of the same T2 part at the threshold T2 was read at, or at 0.025 when T1 does not win', () => {
    const levels = Object.fromEntries(Object.entries(levelsOf(0.05)).map(([t, v]) => [t, t === 'T1' ? v : { '0.025': { level: 0.001 }, '0.05': { level: 0.9 } }]));
    const p01 = { s1: { a: { ...stat(Math.log(0.55), 0.2, 20), ratio: 0.55 }, b: stat(0.2, 0.05), c: codes(-0.3, 0.1) } };
    const [wins, noWin] = [score(p01, levels), score({ ...p01, T1: codes(0.2) }, levels)];
    expect([wins.closed.T1.verdict, wins.s1.threshold]).toEqual(['win', '0.05']);
    expect([noWin.closed.T1.verdict, noWin.s1.threshold]).toEqual(['loss', '0.025']);
    const weak = { s1: { a: { ...stat(Math.log(0.55), 0.2, 20), ratio: 0.55 }, b: stat(0.2, 0.05), c: codes(-0.1, 0.15) } };
    expect([score(weak, levels).s1.verdict, score(weak, levelsOf(0.05)).s1.verdict]).toEqual(['pass', 'no pass']);
    expect(score({ s1: { a: null, b: stat(0.01), c: codes(-0.05) } }).s1.verdict).toBe('no verdict');
  });

  it('prints the behaviour sentence on a T3 with no verdict once T1 wins, and none when T1 does not win [prereg 53]', () => {
    const unreached = { ...WINDOWS, T3: { n: 5, k: 3, reached: false, branch: 'rule', power: null } };
    for (const lines of [analyze.testLinesR4(R4, score({ T3: null }), WINDOWS), analyze.testLinesR4(R4, score({}, levelsOf(0.05), unreached), unreached)]) {
      expect(lines.find((l: string) => l.startsWith('T3 '))).toContain(`; ${hyp.BEHAVIOUR_SENTENCE}`);
      expect(lines.join('\n')).not.toContain(hyp.LESSONS_SENTENCE);
    }
    expect(analyze.testLinesR4(R4, score({ T1: codes(0.2) }), WINDOWS).join('\n')).not.toContain(hyp.BEHAVIOUR_SENTENCE);
  });
});

describe('headline branches and their added sentences (briefs 5 and 8)', () => {
  const stat = (estimate: number, se = 0.01) => ({ estimate, se, df: 20 });
  const codes = (a: number, b = a) => ({ violation: stat(a), excluded: stat(b) });
  const hand = (over: any = {}) => ({ T1: codes(-0.3, -0.2), T3: codes(-0.2), T2a: { ...stat(Math.log(0.52)), ratio: 0.52 }, T2b: stat(0.01), T2c: codes(-0.1), s1: { a: null, b: null, c: null }, ...over });
  const windows = Object.fromEntries(TESTS.map((t) => [t, { n: 3, k: 3, reached: true, branch: 'rule', power: null }]));
  const head = (over: any = {}, levels = levelsOf(0.05), extra: any = {}) => {
    const estimates = hand(over);
    return analyze.headlineR4({ design: R4, scored: analyze.scoreR4(estimates, levels, windows), estimates, effort: 'medium', asOf: '2026-10-11', pooled: -0.01, spendPerSolve: { S2: 1, O1: 2, S1: 1 }, ...extra });
  };

  it('T1 wins and T2 passes: the prereg sentence with the effort, asOf, R, and d as the smaller cut', () => {
    expect(head()).toBe("At medium effort and at list prices on 2026-10-11, Sonnet 5.5 with hippo solved these tasks at 0.52 of the cost per solved task of Opus 5.5 with built-in memory. Its intervals ruled out more than 3 points fewer tasks solved and more than 15 points more first-apply repeats, and hippo cut Sonnet's first-apply repeats by 20.0 points.");
  });

  it('T1 wins and T2 does not pass: the effort, then the prereg sentence', () => {
    expect(head({ T2b: stat(-0.04) })).toBe("At medium effort, hippo cuts Sonnet's repeat mistakes, but this run did not show that Sonnet with hippo meets the Opus bar.");
  });

  it('T1 does not win: names the verdict, gives T2 and T3 none and claims no cost', () => {
    const none = head({ T1: codes(0.2) });
    expect(none).toBe('At medium effort, T1 is loss, so T2 and T3 get no verdict; their estimates follow and this run makes no cost claim.');
    expect(head({ T1: codes(-0.1, -0.1) }, levelsOf(1e-9))).toMatch(/^At medium effort, T1 is (inconclusive|tie), so T2 and T3 get no verdict;/);
  });

  it('adds the pooled sentence below -0.03 and not at -0.02, only to the T2 headline', () => {
    expect(head({}, levelsOf(0.05), { pooled: -0.04 })).toContain('counted per task, it solved 4.0 points fewer than Opus');
    expect(head({}, levelsOf(0.05), { pooled: -0.02 })).not.toContain('counted per task');
    expect(head({ T2b: stat(-0.04) }, levelsOf(0.05), { pooled: -0.09 })).not.toContain('counted per task');
  });

  it('adds the spend sentence when S2 is not below O1 per solve, and not when it is', () => {
    expect(head({}, levelsOf(0.05), { spendPerSolve: { S2: 2.2, O1: 2, S1: 1 } })).toContain('on the scored records; with discarded and rerun work, it cost 1.10 of Opus per solved task');
    expect(head({}, levelsOf(0.05), { spendPerSolve: { S2: 2, O1: 2, S1: 1 } })).toContain('it cost 1.00 of Opus per solved task');
    expect(head({}, levelsOf(0.05), { spendPerSolve: { S2: 1.9, O1: 2, S1: 1 } })).not.toContain('with discarded and rerun work');
  });

  it('names the effort it is given in every branch, and stops on one the rows do not allow [prereg 4]', () => {
    expect(head({}, levelsOf(0.05), { effort: 'low' })).toMatch(/^At low effort and at list prices on 2026-10-11, /);
    expect(head({ T2b: stat(-0.04) }, levelsOf(0.05), { effort: 'high' })).toMatch(/^At high effort, hippo cuts /);
    expect(head({ T1: codes(0.2) }, levelsOf(0.05), { effort: 'low' })).toMatch(/^At low effort, T1 is loss/);
    expect(() => head({}, levelsOf(0.05), { effort: 'extreme' })).toThrow('effort extreme is not one of low, medium, high');
  });

  it('throws when the design rows hold two efforts, naming the design and the efforts', () => {
    const mixed = { ...R4, arms: ['A1', 'S1'] };
    const estimates = hand();
    expect(() => analyze.headlineR4({ design: mixed, scored: analyze.scoreR4(estimates, levelsOf(0.05), windows), estimates, effort: 'medium', asOf: 'x', pooled: 0, spendPerSolve: {} }))
      .toThrow(/^design \(A1, S1\) rows hold efforts null, medium; a headline names one effort \(prereg item 4\)$/);
  });
});

describe('a round 4 read through analyzeZ0 (briefs 5, 6, 9, 12)', () => {
  const memo = <T>(make: () => T) => { let made: T | undefined; return () => (made ??= make()); };
  const win = memo(() => run(corpus()));
  const full = memo(() => text(win()));

  it('prints T1, T2 and T3 with their verdicts, "decides nothing" beside T2 and the lessons sentence on a T3 win', () => {
    expect(win().status).toBe('valid');
    expect(full()).toMatch(/^T1 win[^\n]*violation -[\d.]+ \[[^\n]*excluded -[\d.]+ \[/m);
    expect(full()).toMatch(/^T2 pass \(read at 0\.0(25|5)\), p [\d.]+ \(decides nothing\): a /m);
    expect(full()).toMatch(/^T3 win[^\n]*hippo's lessons cut repeat mistakes$/m);
    expect(full()).toMatch(/^H4 (pass|FAIL)/m);
    expect(full()).toMatch(/^\{?At medium effort and at list prices on 2026-10-11, Sonnet 5\.5 with hippo solved these tasks at [\d.]+ of the cost per solved task of Opus 5\.5/m);
  });

  it('prints the four lines in every branch, and the effort in every headline', () => {
    const cost = run(corpus({ knobs: { ...WIN, S2: { fail: 0.1, resolve: 1, cost: 4 } } }));
    const nothing = run(corpus(), { levels: levelsOf(1e-9) });
    for (const [name, a, headline] of [['win', win(), /^At medium effort and at list prices on/m], ['T2 no pass', cost, /^At medium effort, hippo cuts Sonnet's repeat mistakes/m], ['T1 no win', nothing, /^At medium effort, T1 is \w+, so T2 and T3 get no verdict/m]] as const) {
      const out = text(a);
      expect(out, name).toMatch(headline);
      for (const line of [/^ {2}R, S2 against O1 with both arms priced at the Opus row \(seeds 1 to 3\): /m, /^ {2}H3, S2 against S1, cost per task: /m,
        /^ {2}S2 against S1 cost per solved task, each arm at its own row, every seed: /m, /^ {2}O1 drift/m]) expect(out, `${name} ${line}`).toMatch(line);
      expect(out, name).not.toMatch(/\bA\d\b/);
      expect(out, name).not.toContain('Sonnet alone failed');
    }
    expect(text(nothing)).toMatch(/^T2 no verdict \(T1 is \w+\)/m);
  });

  it('adds no change shown to a ratio whose interval holds 1', () => {
    const same = run(corpus({ knobs: { ...WIN, S2: { fail: 0.1, resolve: 0.8 } } }));
    expect(text(same)).toMatch(/^ {2}R, S2 against O1[^\n]*\[[^\n]*\]; no verdict; no change shown$/m);
    expect(full()).not.toMatch(/^ {2}R, S2 against O1[^\n]*no change shown/m);
  });

  it('adds the drift sentence when O1 did worse than round 3, and not when it did better, and prints raw records, no regrade', () => {
    const [worse, better] = [run(corpus({ knobs: { ...WIN, O1: { fail: 0.5, resolve: 0.3 } } }), { drift: driftOf(drift({ fail: 0.5, resolve: 0.95 })) }), run(corpus({ knobs: { ...WIN, O1: { fail: 0.1, resolve: 1 } } }), { drift: driftOf(drift({ fail: 0.5, resolve: 0.5 })) })];
    const sentence = "O1 did worse than round 3's Opus arm on the same tasks, so the Opus bars in parts (b) and (c) were easier to meet than round 3's Opus would make them.";
    expect(text(worse)).toContain(sentence);
    expect([text(better).includes(sentence), full().includes(sentence)]).toEqual([false, false]);
    expect(text(worse)).toMatch(/^ {2}O1 drift, O1 minus round 3's Opus arm on \d+ shared tasks \(raw records, no regrade, off-pin voids dropped\): resolve [-\d.]+ \[[^\n]*first-apply repeats violation [^\n]*excluded [^\n]*cost per solved task at the Opus row [^\n]*no verdict/m);
  });

  it('prints no shared tasks when no task id joins, and reads the drift with no grading', () => {
    const lone = run(corpus(), { drift: driftOf(drift(undefined, (s) => s.replace('rn-', 'zz-'))) });
    expect(text(lone)).toMatch(/^ {2}O1 drift: no shared tasks$/m);
    const flipped = run(corpus(), { grading: { ...GRADING, flippedLessons: ['rn-repo1-f1-L1'] } });
    expect(JSON.stringify(flipped.hypotheses.drift)).toBe(JSON.stringify(win().hypotheses.drift));
    expect(flipped.hypotheses.estimates.T1.violation.estimate).not.toBe(win().hypotheses.estimates.T1.violation.estimate);
  });

  it('prints the S1 read with the prereg sentences, passing and not passing, and never "Sonnet alone failed"', () => {
    const pass = run(corpus({ knobs: { ...WIN, S1: { fail: 0.2, resolve: 1 } } }));
    const fail = run(corpus({ knobs: { ...WIN, S1: { fail: 0.5, resolve: 1, cost: 4 } } }));
    expect(text(pass)).toContain('In an exploratory read, Sonnet alone also stayed inside the Opus bars on these tasks');
    expect(text(fail)).toContain('In an exploratory read, Sonnet alone did not pass the same test. This read does not test whether hippo made the difference.');
    expect([text(pass), text(fail), full()].some((x) => x.includes('Sonnet alone failed'))).toBe(false);
  });

  it('prints the pooled solve difference, the spend per solve, and the spend sentence only when S2 is not below O1', () => {
    expect(full()).toMatch(/^ {2}pooled task-level solve difference, S2 against O1, seeds 1 to 3: [-\d.]+ points, no verdict$/m);
    expect(full()).toMatch(/^ {2}recorded spend per paired solve: S2 \$[\d.]+, O1 \$[\d.]+, S1 \$[\d.]+; no verdict$/m);
    const dear = run(corpus(), { spend: () => ({ ...SPEND, S2: 1e6 }) });
    expect(text(dear)).toContain('with discarded and rerun work, it cost');
    expect(full()).not.toContain('with discarded and rerun work');
  });

  it('prints every publish-list line, and the reported blocks of round 4 with the H2 maintainer text and the label from the H1 pair', () => {
    for (const arm of R4.arms) {
      expect(full(), arm).toMatch(new RegExp(`^ {2}${arm} first applies [-\\d.]+/[-\\d.]+; later applies [-\\d.]+/[-\\d.]+$`, 'm'));
      expect(full(), arm).toMatch(new RegExp(`^ {2}${arm}: teach [\\d.]+ \\(\\d+\\), first apply [\\d.]+ \\(\\d+\\), later apply [\\d.]+ \\(\\d+\\), set N [\\d.]+ \\(\\d+\\)$`, 'm'));
    }
    expect(full()).toMatch(/^publish: repeat rate per arm, first applies and later applies \(violation\/excluded\)$/m);
    expect(full()).toMatch(/^publish: cost per solved task per arm$/m);
    expect(full()).toMatch(/^publish: cost by task kind, mean cost and count per arm$/m);
    expect(full()).toMatch(/^publish: S4 against S0 per family \(mean and units, violation\/excluded\)$/m);
    expect(full()).toMatch(/^ {2}rn-repo1-f0: violation [-\d.]+ \(\d+\), excluded [-\d.]+ \(\d+\)$/m);
    for (const name of ['S1vS0', 'S4vS1', 'H1', 'H3']) expect(full(), name).toMatch(new RegExp(`^ {2}${name}: `, 'm'));
    expect(full()).toContain('H2 not in round 4: no Codex arm');
    expect(full()).toMatch(/^ {2}tasksSinceTeach 2-4: S2 - S1 /m);
    expect(full()).toMatch(/^ {2}H3: [\d.]+ \[[\d., ]+\] t\(/m);
  });

  it("prints part (a)'s bootstrap interval beside R on the T2 line, as H3 does", () => {
    const b = win().hypotheses.estimates.T2a.bootstrap;
    expect(lines(full()).find((l) => l.startsWith('T2 pass'))).toMatch(new RegExp(String.raw`: a R [\d.]+ \[[^\]]*\] t\([\d.]+\), bootstrap \[${b.low.toFixed(3)}, ${b.high.toFixed(3)}\] \((win|no win)`));
  });

  it('names the effort of the pins file in the headline and the report [prereg 4]', () => {
    const low = run(corpus(), { effort: 'low' });
    expect(low.hypotheses.effort).toBe('low');
    expect(text(low)).toMatch(/^At low effort and at list prices on 2026-10-11, /m);
    expect(text(low)).not.toContain('medium effort');
    expect(() => run(corpus(), { effort: undefined })).toThrow('a round 4 read needs --pins');
  });

  it('drops the O1 positions an off-pin file voids from the drift, and says so', () => {
    const last = Math.max(...corpus().plan.filter((c) => c.sequence === KEYS[0] && c.seed === 1).map((c) => c.position));
    const voids = [{ sequence: KEYS[0], seed: 1, arm: 'O1', position: last, sessionId: null, reason: 'cut', file: 'off.json', index: 0 }];
    const cut = run(corpus(), { voids });
    expect(cut.status).toBe('valid');
    expect(cut.hypotheses.drift.shared).toBeLessThan(win().hypotheses.drift.shared);
    expect(text(cut)).toMatch(/shared tasks \(raw records, no regrade, off-pin voids dropped\)/);
  });

  it('never calls opts.spend without unblinding, or when a gate fails', () => {
    const boom = () => { throw new Error('spend ran'); };
    expect(() => run(corpus(), { unblind: false, spend: boom })).not.toThrow();
    const shut = corpus();
    shut.records[0]!.void = 'operator-canary';
    expect(() => run(shut, { spend: boom })).not.toThrow();
    expect(() => run(corpus(), { spend: boom })).toThrow('spend ran');
  });
});

describe('hypotheses exports keep their arities (brief 11)', () => {
  const ARITY = loose({
    'z0-hypotheses': { acrossRepositories: 1, armRate: 5, bothCodings: 5, byCoding: 1, codexApply: 1, computeHypotheses: 3, computeReported: 4, firstApplyR: 1, harmT: 2, holmVerdicts: 1, inSets: 0, maintainer: 1, mean: 1, ratioOf: 1, ratioT: 3, repeatMistake: 6, repeatMistakeUnits: 5, repeatT: 2, rotationSlots: 1, shareFail: 2, spearman: 2, sum: 1, taskUnits: 5 },
    'z0-analyze': { analyzeZ0: 2, buildReport: 5, loadInputs: 2, parseArgs: 1, renderText: 1, runCli: 1, unplannedDesign: 1 },
    'z0-filters': { abandonedRuns: 2, abandonedTail: 2, applyDrops: 3, countCells: 2, filterOpts: 1, filterRecords: 2, filteredInput: 4, offPinReach: 2, pairTasks: 3, readVoids: 1, retryVoids: 1, withoutRuns: 2 },
  });
  const VALUES = loose({
    'z0-hypotheses': ['A5_NOT_RUN', 'BEHAVIOUR_SENTENCE', 'CODINGS', 'HYPOTHESES', 'LESSONS_SENTENCE', 'NA', 'NOT_RUN', 'NO_N_DATA', 'SINCE_TEACH', 'SPECS'],
    'z0-analyze': ['ABANDONED', 'ITERATIONS', 'NOT_ANALYSED', 'SEED'], 'z0-filters': ['FILTER_KEYS'],
  });

  it('resolves every export of f51baba94 with its arity, and every constant', () => {
    const mods = loose({ 'z0-hypotheses': hyp, 'z0-analyze': analyze, 'z0-filters': filters });
    for (const [name, arities] of Object.entries(ARITY)) {
      for (const [fn, arity] of Object.entries(loose(arities))) expect([name, fn, mods[name][fn].length]).toEqual([name, fn, arity]);
      for (const c of VALUES[name]) expect(mods[name][c], `${name}.${c}`).toBeDefined();
    }
  });
});

describe('round 3 stays as it was', () => {
  it('prints no round 4 line and keeps the r3 reported keys', () => {
    const g = generate({ repos: 3 });
    const a = loose(analyze.analyzeZ0(parse(g.records), { planCells: cells(g), grading: GRADING, ...STAT, unblind: true, refuse: () => null, prices: { 'claude-code': { inputPerMTok: 3, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3, outputPerMTok: 15 } } }));
    expect(Object.keys(a.reported).slice(0, 4)).toEqual(['A1vA0', 'A4vA1', 'X2vX1', 'perArm']);
    expect(a.hypotheses.order).toBeDefined();
    const out = analyze.renderText(analyze.buildReport(a, { warnings: [], grading: GRADING }, STAT, null, []), R3);
    expect(out).not.toMatch(/publish:|O1 drift|knife edge/);
    expect(out).toMatch(/^ {2}tasksSinceTeach 2-4: A2 - A1 /m);
    expect(lines(out).some((l) => l.startsWith('H1 '))).toBe(true);
  });
});

describe('round 4 inputs through runCli (brief 10)', () => {
  const g = corpus();
  const go = (over: Record<string, string> = {}, extra: string[] = [], argv = R4_ARGV) => analyze.runCli([...argv, ...extra], workspace(g, over));
  const without = (flag: string) => { const at = R4_ARGV.indexOf(flag); return [...R4_ARGV.slice(0, at), ...R4_ARGV.slice(at + 2)]; };
  const levels = (over: any) => JSON.stringify({ ...levelsFile('pre-freeze', 0.999), ...over });
  const rule = (mend: (r: ReturnType<typeof seedRule>) => void) => { const r = seedRule(3); mend(r); return JSON.stringify(r); };
  const BAD: [string, Record<string, string>, RegExp][] = [
    ['prices with no asOf', { 'prices.json': JSON.stringify(PRICES_BY_MODEL) }, /prices\.json: .*asOf/],
    ['a levels file with another schema', { 'pre.json': levels({ schema: 'z0-levels/2' }) }, /pre\.json: .*schema/],
    ['a levels file that is no object', { 'b1.json': '[]' }, /b1\.json/],
    ['two pre-freeze levels files', { 'b1.json': JSON.stringify(levelsFile('pre-freeze', 0.999)) }, /pre\.json.*b1\.json.*pre-freeze/],
    ['levels from different sources', { 'b1.json': JSON.stringify({ ...levelsFile('batch-1', 0.999), sources: [{ file: 'scripts/token-eval/z0-size-sim.mjs', sha256: 'zz' }] }) }, /pre\.json.*b1\.json.*different sources/],
    ['a seed rule missing a test', { 'sr.json': rule((r) => { delete loose(r.perTest).T2b; }) }, /sr\.json: .*T2b/],
    ['a seed rule with seeds 10', { 'sr.json': rule((r) => { loose(r.perTest).T1.seeds = 10; }) }, /sr\.json: .*T1.*seeds/],
    ['a seed rule with an unknown branch', { 'sr.json': rule((r) => { loose(r.perTest).T3.branch = 'guess'; }) }, /sr\.json: .*T3.*branch/],
    ['a miss branch with no power', { 'sr.json': rule((r) => { loose(r.perTest).T2a.branch = 'miss'; }) }, /sr\.json: .*T2a.*power/],
    ['a seed rule of another design', { 'sr.json': rule((r) => { r.design = 'r3'; }) }, /sr\.json: .*design/],
    ['a seed rule of another schema', { 'sr.json': rule((r) => { r.schema = 'z0-seed-rule/1'; }) }, /sr\.json: .*schema/],
    ['a seed rule that is null', { 'sr.json': 'null' }, /sr\.json/],
    ['a pins file that is null', { 'pins.json': 'null' }, /pins\.json/],
    ['a pins file with no batch2Keys', { 'pins.json': JSON.stringify({ batch1Keys: 'rn-repo1' }) }, /pins\.json: batch2Keys/],
    ['a pins file with an effort the design does not allow', { 'pins.json': JSON.stringify({ ...PINS, effort: 'extreme' }) }, /pins\.json: effort extreme is not one of low, medium, high/],
    ['a pins file with no effort', { 'pins.json': JSON.stringify({ ...PINS, effort: undefined }) }, /pins\.json: the run's effort is missing; it must be one of low, medium, high/],
    ['a drift plan that is no plan', { 'dp.json': '{}' }, /dp\.json/],
    ['a drift runs file that is missing', { 'dr.jsonl': '' }, /drift-runs|dr\.jsonl/],
  ];

  it.each(BAD)('exits 1 naming the file on %s', (_name, over, message) => {
    const dir = workspace(g, over);
    if (over['dr.jsonl'] === '') fs.rmSync(path.join(dir, 'dr.jsonl'));
    const r = analyze.runCli(R4_ARGV, dir);
    expect([r.code, r.stdout]).toEqual([1, '']);
    expect(r.stderr).toMatch(message);
  });

  it('exits 1 naming the flag on one levels file, no --pins, an empty value and a ledger folder without --unblind', () => {
    const one = go({}, [], [...without('--levels')]);
    expect([one.code, one.stderr]).toEqual([1, expect.stringContaining('each test keeps the lower of its two levels')]);
    expect([go({}, [], without('--pins')).code, go({}, [], without('--pins')).stderr]).toEqual([1, expect.stringContaining('a round 4 read needs --pins')]);
    expect(go({}, ['--seed', '']).stderr).toContain('--seed needs a value');
    expect(go({}, ['--ledger-runs', 'out']).stderr).toContain('--ledger-runs needs --unblind; spend by arm opens the arm codes');
    expect(go({}, ['--unblind']).stderr).toContain('a round 4 read needs --ledger-runs');
  });

  it('reads a blind round 4 read, seals it, and hashes the new inputs in their order, each only when its flag is set', () => {
    const dir = workspace(g);
    const r = analyze.runCli([...R4_ARGV, '--out', 'out.json'], dir);
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain('hypotheses sealed until unblinded');
    expect(r.stdout).toMatch(/^G1 pass: .*; off-pin voided 0 positions \(0\.0%\), within the 5% bar$/m);
    expect(r.stdout).toMatch(/^G3 pass: 0 of \d+ planned \(sequence, seed\)s leaked; first run 0 of \d+ leaked$/m);
    const roles = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).hashes.filter((h: { role: string }) => h.role !== 'source').map((h: { role: string }) => h.role);
    expect(roles).toEqual(['runs', 'plan', 'prices', 'grading', 'levels', 'levels', 'seed-rule', 'pins', 'drift-runs', 'drift-plan']);
  });

  it('checks the prices asOf on the round 4 path only: loadAnalyzeInputs returns, runCli exits 1', () => {
    const over = { 'prices.json': JSON.stringify(PRICES_BY_MODEL) };
    expect(() => analyze.loadAnalyzeInputs(analyze.parseArgs(R4_ARGV), workspace(g, over))).not.toThrow();
    expect(go(over).stderr).toMatch(/prices\.json: .*asOf/);
  });

  it('reads the effort from the pins file', () => {
    const low = loose(analyze.loadAnalyzeInputs(analyze.parseArgs(R4_ARGV), workspace(g, { 'pins.json': JSON.stringify({ ...PINS, effort: 'low' }) })));
    expect(low.effort).toBe('low');
  });

  it('takes the two levels files in either order, sorted by their source field', () => {
    const [pre, b1] = [JSON.stringify(levelsFile('pre-freeze', 0.9, 'c1')), JSON.stringify(levelsFile('batch-1', 0.8, 'c2'))];
    const read = (over: Record<string, string>) => loose(analyze.loadAnalyzeInputs(analyze.parseArgs(R4_ARGV), workspace(g, over)));
    const [normal, swapped] = [read({ 'pre.json': pre, 'b1.json': b1 }), read({ 'pre.json': b1, 'b1.json': pre })];
    expect(normal.levels.T1['0.05']).toMatchObject({ level: 0.8, file: 'b1.json' });
    expect(swapped.levels.T1['0.05']).toMatchObject({ level: 0.8, file: 'pre.json' });
    expect(swapped.notes).toEqual(['minLevels: the levels files were made at different commits, c1 and c2']);
    expect(swapped.notes).toEqual(normal.notes);
    expect(go({ 'pre.json': b1, 'b1.json': pre }).code).toBe(0);
  });
});
