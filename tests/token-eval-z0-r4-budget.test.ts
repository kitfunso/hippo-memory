// Round 4 prereg item 12 and the plan's Budget model: the spend projection, the one admission check, the sealed files and the budget CLI.
// The whole-write cases of atomic-write.mjs sit here too: the plan names no test file for it.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { appendJsonLine, readSealed, writeFileAtomic } from '../scripts/token-eval/atomic-write.mjs';
import { admissionOk, projectSpend, runCli, sequenceGap, stepProjection, wholeRun } from '../scripts/token-eval/z0-budget.mjs';

// Round 3's recorded spend by arm and by batch 1 sequence (r3-bases.py on the round 3 run), unrounded.
const BASIS = { A0: 314.93659099999996, A1: 386.4545920000009, A2: 385.2113900000005, A4: 256.7379992000001, A5: 373.4189512000002 };
const SEQ = {
  q12: { A0: 23.390040399999993, A1: 31.0537406, A2: 27.276879600000004, A4: 21.507720200000005, A5: 25.7946444 },
  q14: { A0: 6.299849600000002, A1: 8.908169000000001, A2: 8.9157628, A4: 4.874098600000001, A5: 8.036368399999999 },
  q140: { A0: 12.632800200000002, A1: 12.9875568, A2: 13.336087199999998, A4: 8.9711754, A5: 13.4532806 },
  q145: { A0: 1.7979228000000003, A1: 1.0015326, A2: 1.2296926000000001, A4: 1.8101713999999998, A5: 1.7773954 },
  q184: { A0: 7.272139400000002, A1: 8.829888200000003, A2: 8.913826, A4: 5.6796945999999995, A5: 8.950295200000003 },
  q190: { A0: 8.991719199999999, A1: 10.146631600000001, A2: 11.240961999999998, A4: 7.870867800000001, A5: 10.227016999999998 },
  q212: { A0: 12.3443082, A1: 15.6111226, A2: 15.932155599999998, A4: 9.772375799999999, A5: 15.209025400000002 },
  q222: { A0: 6.994181, A1: 9.908843399999999, A2: 9.404470600000002, A4: 5.367052199999999, A5: 10.102072399999999 },
  q226: { A0: 8.415646, A1: 9.394431800000003, A2: 10.121354799999999, A4: 5.976598000000001, A5: 10.433823600000004 },
  q238: { A0: 7.886454799999999, A1: 8.901907, A2: 9.308398000000004, A4: 6.080827799999999, A5: 8.855432400000002 },
};
const BATCH2_SEQ = { qa: { A0: 30, A1: 40, A2: 40, A4: 20, A5: 40 }, qb: { A0: 20, A1: 30, A2: 30, A4: 10, A5: 30 }, qc: { A0: 10, A1: 20, A2: 20, A4: 5, A5: 20 } };
const MEAN = 0.3449386223427768;
const BATCH1 = Object.keys(SEQ);
const BATCH2 = Object.keys(BATCH2_SEQ);
const RULE_ARMS = ['O1', 'S1', 'S2', 'S5'];
const cents = (x: number): string => x.toFixed(2);
const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const rule = (n: number) => ({ O1: n, S1: n, S2: n, S5: n });
const sumsOver = (table: Record<string, Record<string, number>>, keys: readonly string[]) => Object.fromEntries(Object.keys(BASIS).map((a) => [a, sum(keys.map((k) => table[k]![a]!))]));

describe('projectSpend on round 3\'s unrounded bases, as r4-projection.py prints it', () => {
  const gap = sequenceGap(SEQ, BATCH1);
  const batch1 = sumsOver(SEQ, BATCH1);
  const spend = (over: { basisByArm?: Record<string, number>; gapByArm?: Record<string, number>; r?: number; seedsByArm?: Record<string, number>; pilotUsd?: number; scale?: number }) => projectSpend({ basisByArm: BASIS, gapByArm: {}, r: 1, seedsByArm: {}, pilotUsd: 0, scale: 1, ...over });

  it('gives 1284.83, 1714.02 and 2143.21 at r = 1, 1.5 and 2 with the $40 pilot', () => {
    expect([1, 1.5, 2].map((r) => cents(spend({ r, pilotUsd: 40 })))).toEqual(['1284.83', '1714.02', '2143.21']);
  });

  it('gives the 5206.29 ceiling with the four rule arms at 9 seeds at r = 2', () => {
    expect(cents(spend({ r: 2, pilotUsd: 40, seedsByArm: rule(9) }))).toBe('5206.29');
  });

  it('gives batch 1\'s 376.34 and 635.94 from its sequence sums with no gap', () => {
    expect([1, 2].map((r) => cents(spend({ r, basisByArm: batch1 })))).toEqual(['376.34', '635.94']);
  });

  it('gives batch 1 with q145\'s gap 412.81 at r = 1 and 697.03 at r = 2', () => {
    expect([1, 2].map((r) => cents(spend({ r, basisByArm: batch1, gapByArm: gap })))).toEqual(['412.81', '697.03']);
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

  it('gives the q145 gaps A0 8.67, A1 11.86, A2 11.49, A4 6.65 and A5 10.56', () => {
    expect(Object.fromEntries(Object.entries(gap).map(([a, x]) => [a, cents(x)]))).toEqual({ A0: '8.67', A1: '11.86', A2: '11.49', A4: '6.65', A5: '10.56' });
  });

  it('refuses a gap that cannot be taken: q145 missing from the keys or from the sequences, or a key with no row', () => {
    expect(() => sequenceGap(SEQ, BATCH1.filter((q) => q !== 'q145'))).toThrow(/do not hold q145/);
    const { q145: dropped, ...without } = SEQ;
    expect(dropped.A0).toBeGreaterThan(0);
    expect(() => sequenceGap(without, BATCH1)).toThrow(/no row for q145/);
    expect(() => sequenceGap(SEQ, [...BATCH1, 'q999'])).toThrow(/no row for q999/);
  });

  it('gives the whole-run check 1641.63 and 2464.81 at r = 1 and 2745.37 and 4059.80 at r = 2, for 3 and 5 seeds, with the pilot and the 1.25 margin', () => {
    const need = (r: number, seeds: number) => cents(40 + 1.25 * wholeRun({ basisByArm: BASIS, gapByArm: gap, r, seeds }));
    expect([need(1, 3), need(1, 5), need(2, 3), need(2, 5)]).toEqual(['1641.63', '2464.81', '2745.37', '4059.80']);
  });
});

/** `n` plan cells over the arms listed, in the runner's plan.json shape. */
const plan = (n: number, arms: readonly string[]) => Array.from({ length: n }, (_, i) => ({ seed: 1, position: i + 1, arm: arms[i % arms.length]!, sequence: 's', taskId: `t${i}`, repo: 'r', kind: 'apply', familyId: 'f', set: 'R' }));
const ALL_ARMS: readonly string[] = DESIGNS.r4.arms;

describe('step projections at the measured mean per record', () => {
  it('projects the smoke, 6 sessions and 2 warm-ups, at $2.76', () => {
    expect(cents(stepProjection({ plans: [plan(6, ALL_ARMS)], meanPerRecord: MEAN, warmupUsd: undefined }))).toBe('2.76');
  });

  it('projects the pilot, 108 sessions and 4 effort sessions, at $38.63 before its 8 warm-ups', () => {
    const plans = [plan(54, ['O1', 'S1', 'S2']), plan(54, ['O1', 'S1', 'S2']), plan(2, ['O1', 'S1']), plan(2, ['O1', 'S1'])];
    expect(cents(stepProjection({ plans, meanPerRecord: MEAN, warmupUsd: 0 }))).toBe('38.63');
    expect(stepProjection({ plans, meanPerRecord: MEAN, warmupUsd: 0.17 })).toBeCloseTo(112 * MEAN + 8 * 0.17, 9);
    expect(stepProjection({ plans, meanPerRecord: MEAN, warmupUsd: 0.17 })).toBeLessThan(40);
  });

  it('projects 118 sessions, 2 more positions in one pilot repository, at $40.70', () => {
    const plans = [plan(60, ['O1', 'S1', 'S2']), plan(54, ['O1', 'S1', 'S2']), plan(2, ['O1', 'S1']), plan(2, ['O1', 'S1'])];
    expect(cents(stepProjection({ plans, meanPerRecord: MEAN, warmupUsd: 0 }))).toBe('40.70');
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

/* ------------------------------------------------------------------------------------------------ the CLI */

const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
interface PilotOver { r?: { S1: number; S2: number }; rArm?: string; rMax?: number | null; flag19?: boolean }
const pilotFile = (over: PilotOver = {}) => ({ schema: 'z0-pilot/1', attempt: 1, tag: 'z0-r4-freeze-1', r: { S1: 1, S2: 1 }, rArm: 'S2', rMax: 1, flag19: false, ledgerTotal: 40, pilotSpend: 36.5, checks: {}, ...over });
const SPEND = { schema: 'z0-spend-basis/1', basisByArm: BASIS, bySequence: { ...SEQ, ...BATCH2_SEQ }, meanPerRecord: MEAN };
const PINS = { batch1Keys: BATCH1.join(','), batch2Keys: BATCH2.join(','), wholeRunSeeds: '5', effort: 'medium', claudeVersion: '2.1.288' };
const SLOW = { r: { S1: 0.3, S2: 0.3 }, rMax: 0.3 };

interface RootOver { spend?: { meanPerRecord: number }; pins?: { batch1Keys?: string | string[]; batch2Keys?: string | string[]; wholeRunSeeds?: string | number }; pilot?: PilotOver }
interface Root { dir: string; log: string; basis: string; pins: string; pilot: string }
interface LogEntry { kind: string; step: string; attempt: number; units: string[]; pinsSha256: string; approved: number; ledgerBefore: number; projection: number; scale: number;
  margin: number; cap: number | null; capSpend: number | null; admitted: boolean; reason: string | null; maxSeed: number | null; at: string; question: string; figure: number | null; stop: boolean; words: string }

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined };
const writeJson = (file: string, body: Json): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};
function makeRoot(over: RootOver = {}): Root {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-budget-'));
  return {
    dir, log: path.join(dir, 'budget-log.jsonl'), basis: writeJson(path.join(dir, 'spend-basis.json'), { ...SPEND, ...over.spend }),
    pins: writeJson(path.join(dir, 'pins-r4.json'), { ...PINS, ...over.pins }), pilot: writeJson(path.join(dir, 'pilot.json'), pilotFile(over.pilot)),
  };
}
const entries = (root: Root): LogEntry[] => (fs.existsSync(root.log) ? fs.readFileSync(root.log, 'utf8').split('\n').filter(Boolean).map((l): LogEntry => JSON.parse(l)) : []);
const last = (root: Root): LogEntry => entries(root).at(-1)!;
const planFile = (root: Root, name: string, cells: readonly Json[]): string => writeJson(path.join(root.dir, name), cells);
const warmups = (root: Root, costs: Record<string, number>): string => {
  for (const [model, cost] of Object.entries(costs)) writeJson(path.join(root.dir, 'warm', `${model}.json`), { model, status: 0, total_cost_usd: cost, result: 'ok' });
  writeJson(path.join(root.dir, 'warm', 'claude-opus-5-5.start.json'), { model: 'claude-opus-5-5', total_cost_usd: 99 });
  return path.join(root.dir, 'warm');
};

interface Call { step: string; approved?: string; ledger?: string; attempt?: string; extra?: readonly string[] }
const admit = (root: Root, c: Call) => runCli(['admit', '--step', c.step, '--attempt', c.attempt ?? '1', '--approved', c.approved ?? '2000', '--ledger-total', c.ledger ?? '0',
  '--spend-basis', root.basis, '--pins', root.pins, '--log', root.log, ...(c.extra ?? [])]);
const goFigure = (root: Root, figure: string) => runCli(['founder-go', '--question', 'figure', '--figure', figure, '--words', 'raise it', '--log', root.log]);
const units = (root: Root, sub: string, keys: readonly string[], tail = 'w1') => keys.flatMap((k) => ['--units', path.join(root.dir, sub, `${k}-${tail}`)]);
const gapOf = sequenceGap(SEQ, BATCH1);

describe('admit: the smoke and the pilot', () => {
  it('admits the smoke at margin 1 and logs one entry with every field', () => {
    const root = makeRoot();
    const r = runCli(['admit', '--step', 'smoke', '--attempt', '1', '--approved', '1035', '--ledger-total', '1000', '--spend-basis', root.basis, '--pins', root.pins, '--log', root.log,
      '--plans', planFile(root, 'smoke.json', plan(6, ALL_ARMS)), '--units', path.join(root.dir, 'smoke', 'w1')], root.dir, () => new Date('2026-11-11T00:00:00Z'));
    expect(r.code).toBe(0);
    const [e] = entries(root);
    expect(e).toMatchObject({ kind: 'admit', step: 'smoke', attempt: 1, units: ['w1'], approved: 1035, ledgerBefore: 1000, scale: 1, margin: 1, cap: null, capSpend: null, admitted: true, reason: null, maxSeed: null, pinsSha256: sha(root.pins), at: '2026-11-11T00:00:00.000Z' });
    expect(cents(e!.projection)).toBe('2.76');
    expect(Object.keys(e!).sort()).toEqual(['admitted', 'approved', 'at', 'attempt', 'cap', 'capSpend', 'kind', 'ledgerBefore', 'margin', 'maxSeed', 'pinsSha256', 'projection', 'reason', 'scale', 'step', 'units']);
  });

  it('refuses a smoke that does not fit with exit 3 and the plan\'s line, and still logs it', () => {
    const root = makeRoot();
    const r = admit(root, { step: 'smoke', approved: '1002', ledger: '1000', extra: ['--plans', planFile(root, 'smoke.json', plan(6, ALL_ARMS))] });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('STOP: smoke does not fit: $1000.00 + $2.76 above $1002.00');
    expect(entries(root)[0]).toMatchObject({ admitted: false, reason: 'figure' });
  });

  it('refuses a pilot over the figure with exit 3 and over $40 with exit 4, and a pilot go for that attempt lifts the cap', () => {
    const root = makeRoot();
    const big = planFile(root, 'pilot-plan.json', plan(118, ['O1', 'S1', 'S2']));
    const pilot = (c: Partial<Call>) => admit(root, { step: 'pilot', ...c, extra: ['--plans', big, '--warmups', warmups(root, { 'claude-opus-5-5': 0.17 }), ...(c.extra ?? [])] });
    const [over40, nofit] = [pilot({ ledger: '0', approved: '2000' }), pilot({ ledger: '1990', approved: '2000' })];
    expect([over40.code, nofit.code]).toEqual([4, 3]);
    expect(over40.stderr).toMatch(/FOUNDER: the pilot projects \$41\.\d\d at r = 2, above its \$40 budget: go on or stop/);
    expect(nofit.stderr).toContain('STOP: pilot does not fit');
    expect(entries(root).map((e) => [e.admitted, e.reason, e.cap])).toEqual([[false, 'cap', 40], [false, 'figure', 40]]);
    const goOn = runCli(['founder-go', '--question', 'pilot', '--figure', '45', '--attempt', '1', '--words', 'go on', '--log', root.log]);
    expect(goOn.code).toBe(0);
    expect(pilot({ ledger: '0', approved: '2000' }).code).toBe(0);
    expect(last(root)).toMatchObject({ admitted: true, cap: 45 });
    expect(pilot({ ledger: '0', approved: '2000', attempt: '2' }).code).toBe(4);
  });

  it('prices the pilot\'s warm-ups at the largest <model>.json cost and ignores the .start.json files', () => {
    const root = makeRoot({ spend: { meanPerRecord: 1 } });
    const r = admit(root, { step: 'pilot', extra: ['--plans', planFile(root, 'p.json', plan(10, ['O1', 'S1'])), '--warmups', warmups(root, { 'claude-opus-5-5': 0.5, 'claude-sonnet-5-5': 2 })] });
    expect(r.code).toBe(0);
    expect(entries(root)[0]!.projection).toBe(10 + 2 * 2);
  });

  it('refuses a warm-ups folder with no <model>.json file, and a file with no cost', () => {
    const root = makeRoot();
    const common = ['--plans', planFile(root, 'p.json', plan(4, ['O1']))];
    fs.mkdirSync(path.join(root.dir, 'empty'));
    const none = admit(root, { step: 'pilot', extra: [...common, '--warmups', path.join(root.dir, 'empty')] });
    expect([none.code, none.stderr]).toEqual([1, expect.stringContaining('holds no <model>.json warm-up file')]);
    writeJson(path.join(root.dir, 'blank', 'claude-opus-5-5.json'), { model: 'claude-opus-5-5' });
    const blank = admit(root, { step: 'pilot', extra: [...common, '--warmups', path.join(root.dir, 'blank')] });
    expect([blank.code, blank.stderr]).toEqual([1, expect.stringContaining('has no total_cost_usd')]);
    expect(entries(root)).toEqual([]);
  });

  it('with ledger 1000, projection 30 and figure 1035 admits the smoke and the pilot', () => {
    const root = makeRoot({ spend: { meanPerRecord: 1 } });
    const thirty = planFile(root, 'thirty.json', plan(28, ['O1', 'S1']));
    const common = { approved: '1035', ledger: '1000' };
    const smoke = admit(root, { step: 'smoke', ...common, extra: ['--plans', thirty] });
    const pilot = admit(root, { step: 'pilot', ...common, extra: ['--plans', thirty, '--warmups', warmups(root, { 'claude-opus-5-5': 1 })] });
    expect([smoke.code, pilot.code, entries(root).map((e) => e.projection)]).toEqual([0, 0, [30, 30]]);
  });

  it('runs a cap-only retry check against the attempt\'s spend and ignores the figure: 25 + 16 exits 4 and 25 + 14 exits 0', () => {
    const root = makeRoot({ spend: { meanPerRecord: 1 } });
    const retry = (n: number) => admit(root, { step: 'pilot', approved: '10', ledger: '5000', extra: ['--cap-only', '--attempt-ledger', '25', '--plans', planFile(root, `r${n}.json`, plan(n, ['O1'])), '--warmups', warmups(root, { 'claude-opus-5-5': 1 })] });
    const [over, under] = [retry(15), retry(13)];
    expect([over.code, under.code]).toEqual([4, 0]);
    expect(over.stderr).toContain('FOUNDER: the pilot projects $41.00 at r = 2, above its $40 budget: go on or stop');
    expect(entries(root).map((e) => [e.projection, e.capSpend, e.cap, e.admitted, e.reason])).toEqual([[16, 25, 40, false, 'cap'], [14, 25, 40, true, null]]);
  });
});

describe('admit: the margin of each step', () => {
  /** The step run twice in fresh roots: once at a loose figure to read its projection P, then at a figure of ledger + `factor` x P, rounded up to the cent. */
  const between = (factor: number, setup: (root: Root) => { step: string; extra: readonly string[] }) => {
    const [probe, tight] = [makeRoot({ pilot: SLOW }), makeRoot({ pilot: SLOW })];
    const first = setup(probe);
    expect(admit(probe, { ...first, approved: '2140', ledger: '100' }).code).toBe(0);
    const second = setup(tight);
    return admit(tight, { ...second, approved: (Math.ceil((100 + factor * last(probe).projection) * 100) / 100).toFixed(2), ledger: '100' });
  };
  const preview = (root: Root) => writeJson(path.join(root.dir, 'seed-preview.json'), { schema: 'z0-seed-preview/1', countsByArm: { ...rule(5), S0: 2, S4: 2 } });
  const scaleAndMark = (root: Root) => ['--scale', writeJson(path.join(root.dir, 'scale.json'), { scale: 1 }), '--mark', path.join(root.dir, 'ADMITTED')];

  it('admits the smoke and the pilot at ledger + 1 x projection, so their margin is 1', () => {
    const plans = (root: Root) => ['--plans', planFile(root, 'plan.json', plan(28, ['O1', 'S1'])), '--warmups', warmups(root, { 'claude-opus-5-5': 1 })];
    expect(between(1, (root) => ({ step: 'smoke', extra: plans(root) })).code).toBe(0);
    expect(between(1, (root) => ({ step: 'pilot', extra: plans(root) })).code).toBe(0);
  });

  it('refuses batch 1, batch 2 and the whole run at ledger + 1.2 x projection, each by its own exit, so their margin is above 1.2', () => {
    expect(between(1.2, (root) => ({ step: 'batch-1', extra: ['--pilot', root.pilot, '--mark', path.join(root.dir, 'M'), ...units(root, 'b1', BATCH1)] })).code).toBe(3);
    expect(between(1.2, (root) => ({ step: 'batch-2', extra: ['--pilot', root.pilot, ...scaleAndMark(root), '--seed-preview', preview(root), ...units(root, 'b2', BATCH2)] })).code).toBe(5);
    expect(between(1.2, (root) => ({ step: 'whole-run', extra: ['--pilot', root.pilot] })).code).toBe(4);
  });

  it('caps the raise below its count at ledger + 1.2 x the full raise\'s projection, so its margin is above 1.2', () => {
    const r = between(1.2, (root) => ({
      step: 'seeds', extra: ['--pilot', root.pilot, ...scaleAndMark(root), '--seed-rule', writeJson(path.join(root.dir, 'rule.json'), { schema: 'z0-seed-rule/2', seeds: rule(5) }), '--seal', path.join(root.dir, 'raise', 'max-seed.json')],
    }));
    expect(r.code).toBe(6);
  });
});

describe('admit: a started scope and the approved figure', () => {
  const smoke = (root: Root, c: Partial<Call> = {}) => admit(root, { step: 'smoke', ...c, extra: ['--plans', planFile(root, 'smoke.json', plan(6, ALL_ARMS)), ...(c.extra ?? [])] });

  it('exits 1 naming the folder when a named unit holds run/, and logs nothing', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root.dir, 'smoke', 'w1', 'run'), { recursive: true });
    const r = smoke(root, { extra: ['--units', path.join(root.dir, 'smoke', 'w1')] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`admit: ${path.join(root.dir, 'smoke', 'w1')} exists; the smoke has started`);
    expect(fs.existsSync(root.log)).toBe(false);
  });

  it('counts a unit folder with a dry plan and no run/ as not started', () => {
    const root = makeRoot();
    writeJson(path.join(root.dir, 'smoke', 'w1', 'dry', 'plan.json'), []);
    expect(smoke(root, { extra: ['--units', path.join(root.dir, 'smoke', 'w1')] }).code).toBe(0);
  });

  it('exits 1 with the plan\'s line at --approved 2140.01 and no figure go, and passes 2140.00', () => {
    const root = makeRoot();
    const r = smoke(root, { approved: '2140.01' });
    expect([r.code, r.stderr]).toEqual([1, expect.stringContaining('--approved 2140.01 is above $2,140.00 and no founder go names it')]);
    expect(fs.existsSync(root.log)).toBe(false);
    expect(smoke(root, { approved: '2140.00' }).code).toBe(0);
  });

  it('passes at 2600 and exits 1 at 2600.01 once a figure go of 2600 is logged', () => {
    const root = makeRoot();
    expect(goFigure(root, '2600').code).toBe(0);
    expect(smoke(root, { approved: '2600' }).code).toBe(0);
    expect(smoke(root, { approved: '2600.01' }).code).toBe(1);
  });

  it('reads only the figure goes: a pilot go of 9000 names no figure', () => {
    const root = makeRoot();
    runCli(['founder-go', '--question', 'pilot', '--figure', '9000', '--attempt', '1', '--words', 'go on', '--log', root.log]);
    expect(smoke(root, { approved: '2600' }).code).toBe(1);
  });
});

describe('admit: the whole run', () => {
  const whole = (root: Root, c: Partial<Call> = {}) => admit(root, { step: 'whole-run', ...c, extra: ['--pilot', root.pilot, ...(c.extra ?? [])] });
  const need = (r: number, seeds: number, ledger: number) => ledger + 1.25 * wholeRun({ basisByArm: BASIS, gapByArm: gapOf, r, seeds });

  it('projects wholeRun at the pilot\'s r and wholeRunSeeds, and prints r with its projection at those seeds and at 9', () => {
    const root = makeRoot({ pilot: SLOW });
    const r = whole(root, { approved: '2140', ledger: '0' });
    const at = (seeds: number) => wholeRun({ basisByArm: BASIS, gapByArm: gapOf, r: 0.3, seeds });
    expect(r.code).toBe(0);
    expect(last(root)).toMatchObject({ step: 'whole-run', margin: 1.25, scale: 1, admitted: true });
    expect(last(root).projection).toBeCloseTo(at(5), 9);
    expect(r.stdout).toContain('r 0.3 from S2');
    expect(r.stdout).toContain(`5 seeds: $${cents(at(5))}`);
    expect(r.stdout).toContain(`9 seeds: $${cents(at(9))}`);
  });

  it('refuses with exit 4 on the figure first, naming what the check needs and the figure approved', () => {
    const root = makeRoot();
    const r = whole(root, { approved: '2140', ledger: '100' });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain(`FOUNDER: the whole run needs $${cents(need(1, 5, 100))}; approved $2140.00`);
    expect(last(root)).toMatchObject({ admitted: false, reason: 'figure' });
  });

  it('refuses a fitting run whose pilot flags r of 1.9 with exit 4, reason r, naming the arm', () => {
    const root = makeRoot({ pilot: { ...SLOW, flag19: true, rArm: 'S1' } });
    const r = whole(root, { approved: '2140', ledger: '0' });
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(/FOUNDER: S1 has r 0\.3 on the pilot, 1\.9 or more: .*0\.95 of Opus's or more/);
    expect(last(root)).toMatchObject({ admitted: false, reason: 'r' });
  });

  it('puts the figure refusal ahead of the r refusal when both hold', () => {
    const root = makeRoot({ pilot: { r: { S1: 1.9, S2: 1.2 }, rArm: 'S1', rMax: 1.9, flag19: true } });
    expect(whole(root, { approved: '2140', ledger: '0' }).stderr).toContain('the whole run needs');
    expect(last(root).reason).toBe('figure');
  });

  it('passes a fitting whole run with exit 0, writes no mark and reads wholeRunSeeds from the pins', () => {
    const root = makeRoot({ pilot: SLOW, pins: { wholeRunSeeds: '3' } });
    expect(whole(root, { approved: '2140', ledger: '0' }).code).toBe(0);
    expect(last(root).projection).toBeCloseTo(wholeRun({ basisByArm: BASIS, gapByArm: gapOf, r: 0.3, seeds: 3 }), 9);
    expect(fs.readdirSync(root.dir).filter((n) => n.includes('ADMITTED'))).toEqual([]);
  });

  it('refuses a wholeRunSeeds outside 3 to 9', () => {
    const root = makeRoot({ pilot: SLOW, pins: { wholeRunSeeds: '12' } });
    expect(whole(root, { approved: '2140' }).stderr).toContain('wholeRunSeeds 12 is not a whole number from 3 to 9');
  });
});

describe('admit: batches', () => {
  const batch1Args = (root: Root, over: readonly string[] = []) => ['--pilot', root.pilot, '--mark', path.join(root.dir, 'batch1', 'ADMITTED'), ...units(root, 'batch1', BATCH1), ...over];

  it('projects batch 1 over its keys with q145\'s gap and pilotUsd 0: 412.81 at r = 1 and 697.03 at r = 2', () => {
    for (const [r, want] of [[1, '412.81'], [2, '697.03']] as const) {
      const root = makeRoot({ pilot: { r: { S1: r, S2: r }, rMax: r } });
      expect(admit(root, { step: 'batch-1', ledger: '40', extra: batch1Args(root) }).code).toBe(0);
      expect(cents(entries(root)[0]!.projection)).toBe(want);
    }
  });

  it('writes its --mark on a pass and none on a refusal, and exits 3 with the plan\'s line', () => {
    const root = makeRoot();
    const mark = path.join(root.dir, 'batch1', 'ADMITTED');
    const refused = admit(root, { step: 'batch-1', approved: '300', ledger: '40', extra: batch1Args(root) });
    const need = 40 + 1.25 * entries(root)[0]!.projection;
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain(`STOP: batch 1 needs $${cents(need)}; approved $300.00`);
    expect(fs.existsSync(mark)).toBe(false);
    expect(entries(root)[0]).toMatchObject({ admitted: false, reason: 'figure', units: BATCH1.map((k) => `${k}-w1`) });
    expect(admit(root, { step: 'batch-1', approved: '1000', ledger: '40', extra: batch1Args(root) }).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(mark, 'utf8'))).toMatchObject({ step: 'batch-1', attempt: 1 });
  });

  it('adds nothing for the pilot: with $40 of pilot in the ledger the projection is projectSpend at pilotUsd 0', () => {
    const root = makeRoot();
    admit(root, { step: 'batch-1', ledger: '40', extra: batch1Args(root) });
    const want = projectSpend({ basisByArm: sumsOver(SEQ, BATCH1), gapByArm: gapOf, r: 1, seedsByArm: {}, pilotUsd: 0, scale: 1 });
    expect(entries(root)[0]!.projection).toBe(want);
  });

  it('projects each key once however many folders a key has: retries and leak reruns', () => {
    const root = makeRoot();
    const extra = batch1Args(root, ['--units', path.join(root.dir, 'batch1', 'q12-w1-a2'), '--units', path.join(root.dir, 'batch1', 'q12-e2'), '--units', path.join(root.dir, 'batch1', 'q12-e2-a3')]);
    expect(admit(root, { step: 'batch-1', ledger: '40', extra }).code).toBe(0);
    expect(cents(entries(root)[0]!.projection)).toBe('412.81');
  });

  it('exits 1 naming both lists when the unit keys differ from the pins file\'s batch1Keys, and logs nothing', () => {
    const root = makeRoot();
    const r = admit(root, { step: 'batch-1', extra: ['--pilot', root.pilot, '--mark', path.join(root.dir, 'm'), ...units(root, 'batch1', BATCH1.slice(1))] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`--units hold the keys ${BATCH1.slice(1).join(',')} but the pins file's batch1Keys are ${BATCH1.join(',')}`);
    expect(entries(root)).toEqual([]);
  });

  it('reads the pins\' key lists whether they are arrays or comma strings', () => {
    const root = makeRoot({ pins: { batch1Keys: BATCH1, batch2Keys: BATCH2, wholeRunSeeds: 5 } });
    expect(admit(root, { step: 'batch-1', ledger: '40', extra: batch1Args(root) }).code).toBe(0);
  });

  it('refuses a unit folder that is no <key>-w<n> or <key>-e<s>', () => {
    const root = makeRoot();
    const r = admit(root, { step: 'batch-1', extra: ['--pilot', root.pilot, '--mark', path.join(root.dir, 'm'), '--units', path.join(root.dir, 'q12-bad')] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('q12-bad is not <key>-w<n> or <key>-e<s>');
  });

  it('exits 1 for a batch step with no --mark', () => {
    const root = makeRoot();
    const r = admit(root, { step: 'batch-1', extra: ['--pilot', root.pilot, ...units(root, 'batch1', BATCH1)] });
    expect([r.code, r.stderr]).toEqual([1, expect.stringContaining('admit needs --mark')]);
  });

  const batch2Args = (root: Root, scale: string, counts: Record<string, number>) => ['--pilot', root.pilot, '--scale', scale, '--mark', path.join(root.dir, 'batch2', 'ADMITTED'),
    '--seed-preview', writeJson(path.join(root.dir, 'seed-preview.json'), { schema: 'z0-seed-preview/1', countsByArm: counts }), ...units(root, 'batch2', BATCH2)];

  it('refuses batch 2 with exit 5 and its line, and projects its keys plus the raise to the seed preview, times the scale', () => {
    const root = makeRoot();
    const scale = writeJson(path.join(root.dir, 'scale.json'), { scale: 1.2, ledger: 480, projection: 400 });
    const extra = batch2Args(root, scale, { ...rule(5), S0: 2, S4: 2 });
    const refused = admit(root, { step: 'batch-2', approved: '600', ledger: '500', extra });
    expect(refused.code).toBe(5);
    expect(refused.stderr).toMatch(/^STOP: batch 2 needs \$\d+\.\d\d; approved \$600\.00; no claim unless the founder raises the figure$/m);
    expect(fs.existsSync(path.join(root.dir, 'batch2', 'ADMITTED'))).toBe(false);
    const raise = { O1: 2, S0: 0, S1: 2, S2: 2, S4: 0, S5: 2 };
    const want = projectSpend({ basisByArm: sumsOver(BATCH2_SEQ, BATCH2), gapByArm: {}, r: 1, seedsByArm: {}, pilotUsd: 0, scale: 1.2 })
      + projectSpend({ basisByArm: BASIS, gapByArm: gapOf, r: 1, seedsByArm: raise, pilotUsd: 0, scale: 1.2 });
    expect(entries(root)[0]).toMatchObject({ step: 'batch-2', scale: 1.2, margin: 1.25, admitted: false, reason: 'figure' });
    expect(entries(root)[0]!.projection).toBeCloseTo(want, 9);
    expect(admit(root, { step: 'batch-2', approved: '2000', ledger: '500', extra }).code).toBe(0);
    expect(fs.existsSync(path.join(root.dir, 'batch2', 'ADMITTED'))).toBe(true);
  });

  it('at scale 1.2 projects 1.2 times the batch 2 projection at scale 1', () => {
    const root = makeRoot();
    const at = (scale: number) => {
      admit(root, { step: 'batch-2', ledger: '0', extra: batch2Args(root, writeJson(path.join(root.dir, `scale-${scale}.json`), { scale }), { ...rule(4), S0: 2, S4: 2 }) });
      return last(root).projection;
    };
    expect(at(1.2)).toBeCloseTo(1.2 * at(1), 9);
  });

  it('exits 1 when batch 2\'s units are not batch2Keys, naming both lists', () => {
    const root = makeRoot();
    const r = admit(root, { step: 'batch-2', extra: ['--pilot', root.pilot, '--scale', writeJson(path.join(root.dir, 's.json'), { scale: 1 }), '--seed-preview', writeJson(path.join(root.dir, 'sp.json'), { schema: 'z0-seed-preview/1', countsByArm: rule(3) }),
      '--mark', path.join(root.dir, 'm'), ...units(root, 'batch2', ['qa'])] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`--units hold the keys qa but the pins file's batch2Keys are ${BATCH2.join(',')}`);
  });

  it('exits 1 for a batch 2 check with no sealed scale file, and for one whose scale file does not parse', () => {
    const root = makeRoot();
    const counts = { ...rule(3), S0: 2, S4: 2 };
    const absent = admit(root, { step: 'batch-2', extra: batch2Args(root, path.join(root.dir, 'no-scale.json'), counts) });
    expect([absent.code, absent.stderr]).toEqual([1, expect.stringContaining('no-scale.json is absent')]);
    const bad = path.join(root.dir, 'scale.json');
    fs.writeFileSync(bad, '{not json');
    const broken = admit(root, { step: 'batch-2', extra: batch2Args(root, bad, counts) });
    expect([broken.code, broken.stderr]).toEqual([1, expect.stringContaining(`${bad}: sealed file does not parse; the harness never rebuilds it`)]);
    expect(entries(root)).toEqual([]);
  });

  it('reads no earlier entry: a second admit of the same step and units projects against its own ledger and logs a new entry', () => {
    const root = makeRoot();
    const first = admit(root, { step: 'batch-1', approved: '300', ledger: '40', extra: batch1Args(root) });
    const second = admit(root, { step: 'batch-1', approved: '2000', ledger: '40', extra: batch1Args(root) });
    expect([first.code, second.code, entries(root).length]).toEqual([3, 0, 2]);
    expect(entries(root)[0]!.projection).toBe(entries(root)[1]!.projection);
  });
});

describe('admit: the seed raise', () => {
  const raiseTo = (j: number, count: number) => projectSpend({
    basisByArm: BASIS, gapByArm: gapOf, r: 1, pilotUsd: 0, scale: 1,
    seedsByArm: Object.fromEntries(['O1', 'S0', 'S1', 'S2', 'S4', 'S5'].map((a) => [a, RULE_ARMS.includes(a) ? Math.min(count, j) - 3 : 0])),
  });
  const seedArgs = (root: Root, count: number) => ['--pilot', root.pilot, '--scale', writeJson(path.join(root.dir, 'scale.json'), { scale: 1 }),
    '--seed-rule', writeJson(path.join(root.dir, 'seed-rule.json'), { schema: 'z0-seed-rule/2', design: 'r4', seeds: rule(count), countsByArm: { ...rule(count), S0: 2, S4: 2 } }),
    '--seal', path.join(root.dir, 'raise', 'max-seed.json'), '--mark', path.join(root.dir, 'raise', 'ADMITTED')];
  const sealed = (root: Root) => readSealed(path.join(root.dir, 'raise', 'max-seed.json'));

  it('admits the whole raise with exit 0 and max-seed <k>, seals the count and writes its mark', () => {
    const root = makeRoot();
    const r = admit(root, { step: 'seeds', approved: '2140', ledger: '100', extra: seedArgs(root, 5) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('max-seed 5');
    expect(sealed(root)).toEqual({ maxSeed: 5, count: 5 });
    expect(fs.existsSync(path.join(root.dir, 'raise', 'ADMITTED'))).toBe(true);
    expect(entries(root)[0]).toMatchObject({ step: 'seeds', maxSeed: 5, admitted: true, reason: null });
    expect(entries(root)[0]!.projection).toBeCloseTo(raiseTo(5, 5), 9);
  });

  it('seals j = 5 for a figure between seeds 5 and 6, exits 6, logs it admitted, and a second call exits 1 and leaves 5', () => {
    const root = makeRoot();
    const [p5, p6] = [raiseTo(5, 9), raiseTo(6, 9)];
    const first = admit(root, { step: 'seeds', approved: cents(100 + 1.25 * ((p5 + p6) / 2)), ledger: '100', extra: seedArgs(root, 9) });
    expect(first.code).toBe(6);
    expect(first.stderr).toContain('CAP: max-seed 5 of 9');
    expect(sealed(root)).toEqual({ maxSeed: 5, count: 9 });
    expect(entries(root)[0]).toMatchObject({ maxSeed: 5, admitted: true, reason: 'cap' });
    expect(entries(root)[0]!.projection).toBeCloseTo(p5, 9);
    const second = admit(root, { step: 'seeds', approved: '2140', ledger: '100', extra: seedArgs(root, 9) });
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('has started');
    expect(sealed(root)).toEqual({ maxSeed: 5, count: 9 });
    expect(entries(root)).toHaveLength(1);
  });

  it('seals 3, writes its mark, logs maxSeed 3 and exits 6 when the ledger is above the figure', () => {
    const root = makeRoot();
    const r = admit(root, { step: 'seeds', approved: '1000', ledger: '1500', extra: seedArgs(root, 9) });
    expect(r.code).toBe(6);
    expect(r.stderr).toContain('CAP: max-seed 3 of 9');
    expect(sealed(root)).toEqual({ maxSeed: 3, count: 9 });
    expect(fs.existsSync(path.join(root.dir, 'raise', 'ADMITTED'))).toBe(true);
    expect(entries(root)[0]).toMatchObject({ maxSeed: 3, admitted: false, reason: 'cap' });
  });

  it('exits 0 with max-seed 3 and a sealed 3 when the rule asks for no raise', () => {
    const root = makeRoot();
    const r = admit(root, { step: 'seeds', approved: '1000', ledger: '10', extra: seedArgs(root, 3) });
    expect([r.code, r.stdout.includes('max-seed 3')]).toEqual([0, true]);
    expect(sealed(root)).toEqual({ maxSeed: 3, count: 3 });
    expect(entries(root)[0]).toMatchObject({ admitted: true, reason: null, maxSeed: 3 });
  });

  it('takes the count from the largest rule arm and caps each arm at its own count', () => {
    const root = makeRoot();
    const args = seedArgs(root, 5);
    writeJson(path.join(root.dir, 'seed-rule.json'), { schema: 'z0-seed-rule/2', design: 'r4', seeds: { O1: 4, S1: 5, S2: 3, S5: 5 } });
    const r = admit(root, { step: 'seeds', approved: '2140', ledger: '0', extra: args });
    expect(r.code).toBe(0);
    expect(sealed(root)).toEqual({ maxSeed: 5, count: 5 });
    const want = projectSpend({ basisByArm: BASIS, gapByArm: gapOf, r: 1, seedsByArm: { O1: 1, S0: 0, S1: 2, S2: 0, S4: 0, S5: 2 }, pilotUsd: 0, scale: 1 });
    expect(entries(root)[0]!.projection).toBeCloseTo(want, 9);
  });

  it('refuses a seed rule with no count for a rule arm, and a seeds step with no --seal', () => {
    const root = makeRoot();
    const args = seedArgs(root, 5);
    writeJson(path.join(root.dir, 'seed-rule.json'), { schema: 'z0-seed-rule/2', seeds: { O1: 5, S1: 5, S2: 5 } });
    const short = admit(root, { step: 'seeds', extra: args });
    expect([short.code, short.stderr]).toEqual([1, expect.stringContaining('has no seed count for S5')]);
    const noSeal = admit(root, { step: 'seeds', extra: [...args.slice(0, 6), ...args.slice(8)] });
    expect([noSeal.code, noSeal.stderr]).toEqual([1, expect.stringContaining('admit needs --seal')]);
    expect(fs.existsSync(path.join(root.dir, 'raise', 'max-seed.json'))).toBe(false);
  });
});

describe('scale and founder-go', () => {
  const scaleArgs = (root: Root, ledger: string) => ['scale', '--ledger-total', ledger, '--spend-basis', root.basis, '--pins', root.pins, '--pilot', root.pilot, '--out', path.join(root.dir, 'scale.json')];
  const go = (root: Root, ...rest: string[]) => runCli(['founder-go', '--log', root.log, ...rest]);

  it('writes the ledger over batch 1\'s scale-1 projection, and a second call leaves the file as it was', () => {
    const root = makeRoot();
    const projection = projectSpend({ basisByArm: sumsOver(SEQ, BATCH1), gapByArm: gapOf, r: 1 });
    expect(runCli(scaleArgs(root, '826')).code).toBe(0);
    const file = path.join(root.dir, 'scale.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ scale: 826 / projection, ledger: 826, projection });
    const before = fs.readFileSync(file);
    const again = runCli(scaleArgs(root, '999'));
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`scale ${826 / projection} (sealed`);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('feeds a later batch 2 check the same scale it sealed, after a resume', () => {
    const root = makeRoot();
    runCli(scaleArgs(root, '826'));
    const sealedScale: number = readSealed(path.join(root.dir, 'scale.json')).scale;
    const preview = writeJson(path.join(root.dir, 'sp.json'), { schema: 'z0-seed-preview/1', countsByArm: { ...rule(3), S0: 2, S4: 2 } });
    admit(root, { step: 'batch-2', extra: ['--pilot', root.pilot, '--scale', path.join(root.dir, 'scale.json'), '--seed-preview', preview, '--mark', path.join(root.dir, 'm'), ...units(root, 'b2', BATCH2)] });
    expect(last(root).scale).toBe(sealedScale);
  });

  it('refuses a scale over a ledger of 0 and writes no file', () => {
    const root = makeRoot();
    expect(runCli(scaleArgs(root, '0')).code).toBe(1);
    expect(fs.existsSync(path.join(root.dir, 'scale.json'))).toBe(false);
  });

  it('logs a founder go with every field, the figure and attempt null when not given', () => {
    const root = makeRoot();
    expect(go(root, '--question', 'power', '--words', 'go on').code).toBe(0);
    expect(go(root, '--question', 'pilot', '--figure', '45', '--attempt', '2', '--words', 'go on', '--stop').code).toBe(0);
    expect(entries(root).map((e) => [e.kind, e.question, e.figure, e.stop, e.words])).toEqual([['founder-go', 'power', null, false, 'go on'], ['founder-go', 'pilot', 45, true, 'go on']]);
    expect(Object.keys(entries(root)[0]!).sort()).toEqual(['at', 'attempt', 'figure', 'kind', 'question', 'stop', 'words']);
  });

  it('exits 1 for empty words, a figure go with no figure, a pilot go with no attempt, and an unknown question', () => {
    const root = makeRoot();
    expect(go(root, '--question', 'power', '--words', '  ').code).toBe(1);
    expect(go(root, '--question', 'figure', '--words', 'w').stderr).toContain('founder-go needs --figure');
    expect(go(root, '--question', 'pilot', '--figure', '45', '--words', 'w').stderr).toContain('founder-go needs --attempt');
    expect(go(root, '--question', 'cash', '--words', 'w').code).toBe(1);
    expect(fs.existsSync(root.log)).toBe(false);
  });

  it('exits 1 for a whole-run go after a figure refusal, and logs one after an r refusal', () => {
    const figure = makeRoot();
    admit(figure, { step: 'whole-run', approved: '2140', ledger: '100', extra: ['--pilot', figure.pilot] });
    expect(last(figure).reason).toBe('figure');
    const refused = go(figure, '--question', 'whole-run', '--words', 'go');
    expect([refused.code, refused.stderr]).toEqual([1, expect.stringContaining('refused on the figure')]);
    expect(entries(figure)).toHaveLength(1);
    const r = makeRoot({ pilot: { ...SLOW, flag19: true } });
    admit(r, { step: 'whole-run', approved: '2140', ledger: '0', extra: ['--pilot', r.pilot] });
    expect(last(r).reason).toBe('r');
    expect(go(r, '--question', 'whole-run', '--words', 'go').code).toBe(0);
    expect(last(r).question).toBe('whole-run');
  });
});

describe('report', () => {
  const logged = (root: Root, items: readonly object[]) => {
    for (const e of items) appendJsonLine(root.log, e);
  };
  const entry = (step: string, ledgerBefore: number, projection: number, over: { admitted?: boolean; reason?: string | null } = {}) => ({ kind: 'admit', step, attempt: 1, ledgerBefore, projection, admitted: true, reason: null, ...over });
  const report = (root: Root, ...rest: string[]) => runCli(['report', '--log', root.log, '--ledger-total', '780', '--approved', '2140', '--pins', root.pins, ...rest]);

  it('prints each admitted step\'s projection against the ledger growth to the next entry, a refused one included, then the pilot, r, effort and total', () => {
    const root = makeRoot();
    logged(root, [entry('batch-1', 40, 400), entry('batch-2', 440, 300, { admitted: false, reason: 'figure' }), entry('batch-2', 440, 300)]);
    const r = report(root, '--pilot', root.pilot);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      'batch-1 attempt 1: projected $400.00, ledger grew $400.00',
      'batch-2 attempt 1: projected $300.00, ledger grew $340.00; OVERRUN by $40.00',
      'pilot: $36.50 against $40', 'r S1: 1', 'r S2: 1', 'effort: medium', 'total: $780.00 against approved $2140.00',
    ]);
  });

  it('names exactly the steps that grew above their projection', () => {
    const root = makeRoot();
    logged(root, [entry('batch-1', 40, 400), entry('batch-2', 500, 300)]);
    const lines = report(root).stdout.trim().split('\n');
    expect(lines[0]).toBe('batch-1 attempt 1: projected $400.00, ledger grew $460.00; OVERRUN by $60.00');
    expect(lines[1]).toBe('batch-2 attempt 1: projected $300.00, ledger grew $280.00');
    expect(lines.filter((l: string) => l.includes('OVERRUN'))).toHaveLength(1);
  });

  it('prints pilot: none when no pilot file is given or the file is absent, and flags a total over the approved figure', () => {
    const root = makeRoot();
    expect(report(root).stdout).toContain('pilot: none');
    expect(report(root, '--pilot', path.join(root.dir, 'missing.json')).stdout).toContain('pilot: none');
    const over = runCli(['report', '--log', root.log, '--ledger-total', '2200', '--approved', '2140', '--pins', root.pins]);
    expect(over.stdout).toContain('total: $2200.00 against approved $2140.00; OVER by $60.00');
  });

  it('with --stopped names the stop and its step, reads the effort from the pins and prints no headline line otherwise', () => {
    const root = makeRoot();
    const r = report(root, '--stopped', 'second-failure', '--step', '1');
    expect(r.stdout).toContain('stopped: second-failure at step 1');
    expect(r.stdout).toContain('pilot: none');
    expect(r.stdout).toContain('effort: medium');
    expect(r.stdout).toContain('headline: none, the run stopped at second-failure');
    expect(report(root).stdout).not.toContain('headline');
  });

  it('exits 1 for --stopped with no --step', () => {
    expect(report(makeRoot(), '--stopped', 'g2').code).toBe(1);
  });
});

describe('project', () => {
  it('prints the lines of r4-projection.py that the plan\'s checks name, at 2 decimals', () => {
    const root = makeRoot();
    const r = runCli(['project', '--spend-basis', root.basis, '--pins', root.pins]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      'projection at r=1, with the pilot: 1284.83', 'projection at r=1.5, with the pilot: 1714.02', 'projection at r=2, with the pilot: 2143.21', 'ceiling at r=2, with the pilot: 5206.29',
      'batch 1 at r=1, no pilot: 376.34', 'batch 1 at r=2, no pilot: 635.94',
      'q145 gap, A0: 8.67', 'q145 gap, A1: 11.86', 'q145 gap, A2: 11.49', 'q145 gap, A4: 6.65', 'q145 gap, A5: 10.56',
      'figure the whole-run check needs at r=1, 3 and 5 seeds: 1641.63, 2464.81', 'figure the whole-run check needs at r=2, 3 and 5 seeds: 2745.37, 4059.80',
    ]);
  });
});

describe('usage errors', () => {
  it('exits 1 with the usage text for an unknown command, an unknown flag, a missing flag, a flag with no value and a repeated flag', () => {
    const root = makeRoot();
    const base = ['admit', '--step', 'smoke', '--attempt', '1', '--approved', '10', '--ledger-total', '0', '--spend-basis', root.basis, '--pins', root.pins, '--log', root.log];
    const bad = [runCli(['cash']), runCli([]), runCli([...base, '--colour', 'red']), runCli(base.slice(0, -2)), runCli([...base, '--plans']), runCli([...base, '--log', root.log])];
    expect(bad.map((r) => r.code)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(bad.every((r) => r.stderr.includes('usage: z0-budget.mjs admit'))).toBe(true);
    expect(bad[3]!.stderr).toContain('admit needs --log');
    expect(bad[5]!.stderr).toContain('--log given twice');
  });

  it('exits 1 for an unknown step, a figure that is no USD amount and an attempt that is no whole number', () => {
    const root = makeRoot();
    expect(admit(root, { step: 'drive' }).stderr).toContain('--step drive is not one of');
    expect(admit(root, { step: 'smoke', approved: 'lots' }).stderr).toContain('--approved lots is not a USD figure');
    expect(admit(root, { step: 'smoke', approved: '-5' }).code).toBe(1);
    expect(admit(root, { step: 'smoke', attempt: '0' }).stderr).toContain('--attempt 0 is not a whole number from 1');
  });

  it('exits 1 for a spend basis or pilot file of the wrong schema or with no usable number, naming the file', () => {
    const root = makeRoot();
    const wrong = writeJson(path.join(root.dir, 'wrong.json'), { ...SPEND, schema: 'z0-spend-basis/9' });
    const plans = ['--plans', planFile(root, 'smoke.json', plan(6, ALL_ARMS))];
    const withBasis = runCli(['admit', '--step', 'smoke', '--attempt', '1', '--approved', '10', '--ledger-total', '0', '--spend-basis', wrong, '--pins', root.pins, '--log', root.log, ...plans]);
    expect(withBasis.stderr).toContain(`${wrong}: schema is z0-spend-basis/9`);
    const flat = makeRoot({ spend: { meanPerRecord: 0 } });
    expect(admit(flat, { step: 'smoke', extra: plans }).stderr).toContain('meanPerRecord must be a number above 0');
    const noR = makeRoot({ pilot: { rMax: null } });
    expect(admit(noR, { step: 'whole-run', extra: ['--pilot', noR.pilot] }).stderr).toContain('rMax must be a number above 0');
  });
});

/* ------------------------------------------------------------------------------------------- atomic-write */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'z0-atomic-'));
const busy = (code: string): Error => Object.assign(new Error(`${code}: busy`), { code });

describe('writeFileAtomic', () => {
  it('writes the whole text, making the folder', () => {
    const file = path.join(tmp(), 'a', 'b', 'out.json');
    writeFileAtomic(file, '{"a":1}\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['out.json']);
  });

  it('killed between the temp write and the rename leaves the target as it was, and the next call deletes the temp', () => {
    const file = path.join(tmp(), 'out.json');
    writeFileAtomic(file, 'old');
    const killed = () => { throw new Error('killed'); };
    expect(() => writeFileAtomic(file, 'new', killed)).toThrow('killed');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('out.json.tmp-'))).toHaveLength(1);
    fs.writeFileSync(path.join(path.dirname(file), 'out.json.tmp-424242'), 'half');
    writeFileAtomic(file, 'newer');
    expect(fs.readFileSync(file, 'utf8')).toBe('newer');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['out.json']);
  });

  it('leaves another file\'s temp alone', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'other.json.tmp-1'), 'x');
    writeFileAtomic(path.join(dir, 'out.json'), 'y');
    expect(fs.readdirSync(dir).sort()).toEqual(['other.json.tmp-1', 'out.json']);
  });

  it('retries a busy rename 3 times and then writes', () => {
    const file = path.join(tmp(), 'out.json');
    let calls = 0;
    writeFileAtomic(file, 'done', (from, to) => {
      calls++;
      if (calls <= 3) throw busy('EBUSY');
      fs.renameSync(from, to);
    });
    expect([calls, fs.readFileSync(file, 'utf8')]).toEqual([4, 'done']);
  });

  it('throws the busy error when the rename stays busy, after 4 tries, and never retries another error', () => {
    const file = path.join(tmp(), 'out.json');
    let calls = 0;
    expect(() => writeFileAtomic(file, 'x', () => { calls++; throw busy('EPERM'); })).toThrow(/EPERM/);
    expect(calls).toBe(4);
    calls = 0;
    expect(() => writeFileAtomic(file, 'x', () => { calls++; throw busy('ENOENT'); })).toThrow(/ENOENT/);
    expect(calls).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('appendJsonLine and readSealed', () => {
  it('appends one line per call and creates the file', () => {
    const file = path.join(tmp(), 'log.jsonl');
    appendJsonLine(file, { a: 1 });
    appendJsonLine(file, { b: 2 });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('drops a torn last line first, after lines that hold multi-byte characters', () => {
    const file = path.join(tmp(), 'log.jsonl');
    fs.writeFileSync(file, '{"name":"é"}\n{"name":"ü"}\n{"b":');
    appendJsonLine(file, { c: 3 });
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).toEqual([{ name: 'é' }, { name: 'ü' }, { c: 3 }]);
  });

  it('reads a sealed file, null when it is absent, and throws the plan\'s line when it does not parse', () => {
    const dir = tmp();
    expect(readSealed(path.join(dir, 'none.json'))).toBeNull();
    writeFileAtomic(path.join(dir, 's.json'), '{"scale":1.2}\n');
    expect(readSealed(path.join(dir, 's.json'))).toEqual({ scale: 1.2 });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"scale":');
    expect(() => readSealed(path.join(dir, 'bad.json'))).toThrow(`${path.join(dir, 'bad.json')}: sealed file does not parse; the harness never rebuilds it`);
  });

  it('a budget log with a torn last line is read without it, and the next entry lands whole', () => {
    const root = makeRoot();
    fs.writeFileSync(root.log, `${JSON.stringify({ kind: 'founder-go', question: 'figure', figure: 2600, attempt: null, stop: false, words: 'w', at: 'x' })}\n{"kind":"admit","ste`);
    const r = admit(root, { step: 'smoke', approved: '2600', extra: ['--plans', planFile(root, 'smoke.json', plan(6, ALL_ARMS))] });
    expect(r.code).toBe(0);
    expect(entries(root).map((e) => e.kind)).toEqual(['founder-go', 'admit']);
  });
});
