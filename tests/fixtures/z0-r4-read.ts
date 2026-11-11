/** Round 4 analyzer fixtures: a corpus, its inputs and a file workspace, shared by the analyzer tests. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DESIGNS } from '../../scripts/token-eval/arms.mjs';
import { parsePlan, parseZ0Records } from '../../scripts/token-eval/z0-records.mjs';
import { GRADING, PRICES_BY_MODEL, generate, jsonl, planOf, type GenOpts, type Generated, type Knobs, type Z0Record } from './z0-gen.js';

// The fixtures hand untyped module results to assertions, so a reader of them needs no cast.
export const loose = (x: any): any => x;

export const R4 = DESIGNS.r4;
export const R3 = DESIGNS.r3;
export const PRICES4 = { ...PRICES_BY_MODEL, asOf: '2026-10-11' };
export const STAT = { iterations: 200, seed: 1 };
export const TESTS = ['T1', 'T3', 'T2a', 'T2b', 'T2c', 'H4'];
export const REPOS = 4;
export const KEYS = Array.from({ length: REPOS }, (_, i) => `rn-repo${i + 1}`);

export const parse = (recs: readonly Z0Record[]) => parseZ0Records(jsonl(recs), 'runs.jsonl').records;
export const cells = (g: Generated) => parsePlan(JSON.stringify(g.plan), 'plan.json');

/** Seed 3's records copied to seeds 4 up to `to`, for the arms that run seed 3 (S0 and S4 stop at 2); `only` limits the copy to some records and seeds. */
export function raise(g: Generated, to: number, only: (r: Z0Record, seed: number) => boolean = () => true): Generated {
  const extra: Z0Record[] = [];
  for (const r of g.records) {
    if (r.seed !== 3) continue;
    for (let seed = 4; seed <= to; seed++) if (only(r, seed)) extra.push({ ...structuredClone(r), seed, order: r.order + (seed - 3) * 1_000_000 });
  }
  const records = [...g.records, ...extra];
  return { records, plan: planOf(records) };
}

/** S2 repeats least and resolves always, so every test has a helpful estimate; a level of 0.999 then lets each one win. */
export const WIN = { O1: { fail: 0.5, resolve: 0.8 }, S1: { fail: 0.5 }, S2: { fail: 0.1, resolve: 1 }, S5: { fail: 0.5 } };
export const corpus = (opts: GenOpts = {}) => generate({ design: R4, repos: REPOS, knobs: WIN, ...opts });

const entry = (level: number) => ({ level, setBy: 'rule at bounds', cells: [{ setting: 'rule at bounds', size: 0.02, simError: 0.001 }] });
const both = (level: number) => ({ '0.025': entry(level), '0.05': entry(level) });
const SOURCES = [{ file: 'scripts/token-eval/z0-size-sim.mjs', sha256: 'aa' }, { file: 'scripts/token-eval/z0-verdict-r4.mjs', sha256: 'cc' }];
export const levelsFile = (source: string, level: number, commit = 'c1') => ({
  schema: 'z0-levels/1', source, draws: 20_000, commit, sources: SOURCES, floorFlags: [],
  levels: { T1: { '0.05': entry(level) }, T3: both(level), T2a: both(level), T2b: both(level), T2c: both(level) },
});
/** What `minLevels` returns, for a caller that skips the files. */
export const levelsOf = (level: number) => Object.fromEntries(['T1', 'T3', 'T2a', 'T2b', 'T2c'].map((t) => [t, { '0.025': { level }, '0.05': { level } }]));

export const seedRule = (n = 3, perTest: any = {}) => ({
  schema: 'z0-seed-rule/2', design: 'r4',
  perTest: Object.fromEntries(TESTS.map((t) => [t, { seeds: n, branch: 'rule', predictedSE: { atCount: 0.05, at9: 0.04 }, power: null, ...perTest[t] }])),
  seeds: { O1: n, S1: n, S2: n, S5: n }, countsByArm: { O1: n, S0: 2, S1: n, S2: n, S4: 2, S5: n }, reasons: [], stop: null,
});

/** Round 3's Opus arm on the same 4 repositories: seeds 1 to 3, the same task ids. */
export function drift(knobs: Knobs = { fail: 0.5, resolve: 0.8 }, rename = (s: string) => s) {
  const g = generate({ arms: ['A1'], repos: REPOS, knobs: { A1: knobs } });
  const records = g.records.map((r) => ({ ...r, sequence: rename(r.sequence), taskId: rename(r.taskId) }));
  return { records, plan: planOf(records) };
}
export const driftOf = (d: { records: Z0Record[]; plan: unknown[] }) => ({ records: parse(d.records), planCells: parsePlan(JSON.stringify(d.plan), 'drift-plan.json') });
export const SPEND = { O1: 100, S0: 10, S1: 40, S2: 45, S4: 10, S5: 40 };

/** One `analyzeZ0` read of a round 4 corpus with every input a round 4 read needs. */
export function readInputs(g: Generated, over: any = {}) {
  const d = drift();
  return {
    planCells: cells(g), design: R4, prices: PRICES4, grading: GRADING, ...STAT, unblind: true, refuse: () => null,
    levels: levelsOf(0.999), seedRule: seedRule(3), batchKeys: KEYS, notes: [], spend: () => SPEND,
    drift: driftOf(d), ...over,
  };
}

const dirs: string[] = [];
export const cleanUp = () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
export const PINS = { batch1Keys: KEYS.slice(0, 2).join(','), batch2Keys: KEYS.slice(2).join(',') };

/** A folder holding a round 4 read's files; `over` adds or replaces a file. */
export function workspace(g: Generated, over: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-r4-analyze-'));
  dirs.push(dir);
  const d = drift();
  const files = {
    'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES4), 'grading.json': JSON.stringify(GRADING),
    'drop.json': JSON.stringify({ droppedLessons: [], droppedFamilies: [] }), 'pre.json': JSON.stringify(levelsFile('pre-freeze', 0.999)),
    'b1.json': JSON.stringify(levelsFile('batch-1', 0.999)), 'sr.json': JSON.stringify(seedRule(3)), 'pins.json': JSON.stringify(PINS),
    'dr.jsonl': jsonl(d.records), 'dp.json': JSON.stringify(d.plan), ...over,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

export const R4_FILES = ['--levels', 'pre.json', '--levels', 'b1.json', '--seed-rule', 'sr.json', '--pins', 'pins.json', '--drift-runs', 'dr.jsonl', '--drift-plan', 'dp.json'];
export const R4_ARGV = ['--design', 'r4', '--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--grading', 'grading.json', ...R4_FILES];
