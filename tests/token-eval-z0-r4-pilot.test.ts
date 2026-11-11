// Round 4 prereg item 11 and plan slice P: z0-pilot reads the pilot and effort folders and writes the pilot.json that z0-budget reads.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ARM_TABLE, DESIGNS } from '../scripts/token-eval/arms.mjs';
import { GATE_MARGIN, R_FLAG, listOf, readBasis, readPins, runCli as budgetCli, sequenceGap, wholeRun, wholeRunSeeds } from '../scripts/token-eval/z0-budget.mjs';
import { costOf } from '../scripts/token-eval/z0-prices.mjs';
import { rSummary, runCli } from '../scripts/token-eval/z0-pilot.mjs';
import { PRICES_BY_MODEL, crash, generate, planOf, type PlanCell, type Z0Record } from './fixtures/z0-gen.js';

// SAFETY: every ARM_TABLE row of a round 4 arm carries a model; the cast only widens its literal keys to string.
const ROWS = ARM_TABLE as Readonly<Record<string, { model: string }>>;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const ENV_KEYS = ['PATH', 'HOME', 'PIP_CONSTRAINT', 'VIRTUAL_ENV'];
const FIRST = 'rn-repo1-t3';
const SECOND = 'rn-repo1-t5';
const SPEND = { schema: 'z0-spend-basis/1', basisByArm: { A0: 60, A1: 100, A2: 100, A4: 40, A5: 90 }, meanPerRecord: 0.3, bySequence: {
  q12: { A0: 20, A1: 30, A2: 30, A4: 10, A5: 25 }, q145: { A0: 2, A1: 2, A2: 2, A4: 2, A5: 2 }, q140: { A0: 10, A1: 12, A2: 12, A4: 6, A5: 12 } } };
const PINS = { batch1Keys: 'q12,q145,q140', batch2Keys: 'qa,qb', wholeRunSeeds: '5', effort: 'medium', claudeVersion: '2.1.288' };

interface Rec extends Z0Record { model: string; costUsd: number | null; envKeys?: string[]; hookCancels?: Record<string, number> }
interface Folder { dir: string; records: Rec[]; cells: PlanCell[] }
type Void = { sequence: string; seed: number; arm: string; position: number; sessionId: string | null; reason: string };
interface Corpus { root: string; pilot: Folder[]; low: Folder; high: Folder; prices: string; basis: string; pins: string; pinsLow: string; pinsHigh: string; tasks: string }
interface Hash { role: string; file: string; sha256: string; tree?: boolean }
interface PilotJson { schema: string; attempt: number; tag: string; r: { S1: number | null; S2: number | null }; rArm: string | null; rMax: number | null; flag19: boolean; ledgerTotal: number; pilotSpend: number; checks: Record<string, string>; hashes: Hash[] }
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined };
type Kv = readonly (readonly [string, string])[];

/* ------------------------------------------------------------------------------------------ the fixture */

const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const writeJson = (file: string, body: Json): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body)}\n`);
  return file;
};
const price = (r: Rec): number => costOf(r, PRICES_BY_MODEL, { design: DESIGNS.r4, rowModel: r.model });
const priced = (r: Rec): Rec => {
  r.costUsd = r.usage === null ? null : price(r);
  return r;
};
const dress = (r: Z0Record): Rec => ({ ...r, model: ROWS[r.arm]!.model, envKeys: [...ENV_KEYS], surfaceRestored: true, hookCancels: {}, costUsd: null });
const setOutput = (r: Rec, tokens: number): Rec => {
  const u = r.usage!;
  r.usage = { firstSession: { ...u.firstSession, outputTokens: tokens }, extra: { ...u.extra, outputTokens: 0 } };
  return priced(r);
};
const runsOf = (f: Folder): string => path.join(f.dir, 'runs.jsonl');
const planFileOf = (f: Folder): string => path.join(f.dir, 'plan.json');
const offPinOf = (f: Folder): string => path.join(f.dir, 'off-pin.json');
const folderOf = (root: string, name: string, records: Rec[]): Folder => ({ dir: path.join(root, name), records, cells: planOf(records) });
const find = (f: Folder, arm: string, position: number): Rec => f.records.find((r) => r.arm === arm && r.position === position)!;

function save(f: Folder): void {
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(runsOf(f), `${f.records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  fs.writeFileSync(planFileOf(f), JSON.stringify(f.cells));
}

/** `g1-pins`' file for one folder; `also` names more runs files, `pins` is the pins file it records. */
function offPin(f: Folder, pins: string, voids: readonly Void[] = [], also: readonly Folder[] = []): string {
  const runs = [f, ...also].map((x) => ({ dir: x.dir, file: 'runs.jsonl', sha256: sha(runsOf(x)) }));
  return writeJson(offPinOf(f), { schema: 'z0-offpin/1', runs, pins: { file: pins, sha256: sha(pins) }, planOf: { file: planFileOf(f), sha256: sha(planFileOf(f)) }, voids, envOutside: [] });
}

const prefixOf = (c: Corpus, arm: string, position: number): string => path.join(c.pilot[0]!.dir, 'runs', 'rn-repo1', arm, 'seed1', 'venv', String(position));
const venvPath = (c: Corpus, arm: string, task: string): string => path.join(c.pilot[0]!.dir, 'raw', 'rn-repo1', arm, 'seed1', `${task}.venv.txt`);
const first = (c: Corpus, arm: string): Kv => [['prefix', prefixOf(c, arm, 3)], ['packages', 'pip,six'], ['setup_ms', '1200'], ['import_six', 'ok'], ['packages_end', 'pip,six']];
const second = (c: Corpus, arm: string): Kv => [['prefix', prefixOf(c, arm, 5)], ['packages', 'pip'], ['setup_ms', '900'], ['import_six', 'fail'], ['packages_end', 'pip']];
const put = (c: Corpus, arm: string, task: string, kv: Kv): void => {
  fs.mkdirSync(path.dirname(venvPath(c, arm, task)), { recursive: true });
  fs.writeFileSync(venvPath(c, arm, task), `${kv.map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
};
/** `kv` with `key` set to `value`, or dropped when `value` is null. */
const edit = (kv: Kv, key: string, value: string | null): Kv => {
  const rest = kv.filter(([k]) => k !== key);
  return value === null ? rest : [...rest, [key, value]];
};

const tasksFile = (seq: string, ids: readonly string[], venv?: Json): Json => ({ sequences: [{ id: seq, cluster: 'c', repo: 'r', tasks: ids.map((id) => ({ id })) }], venvCheck: venv });
const TASK_IDS = Array.from({ length: 18 }, (_, i) => `rn-repo1-t${i}`);
const venvCheck = (over: { [key: string]: string } = {}): Json => ({ sequence: 'rn-repo1', first: FIRST, second: SECOND, package: 'six', version: '1.17.0', ...over });

function build(over: { s2Cost?: number } = {}): Corpus {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-pilot-'));
  const gen = generate({ design: DESIGNS.r4, arms: ['O1', 'S1', 'S2'], repos: 2, knobs: over.s2Cost === undefined ? {} : { S2: { cost: over.s2Cost } } });
  const seed1 = gen.records.filter((r) => r.seed === 1).map(dress);
  const sequenceOf = (n: number): Rec[] => seed1.filter((r) => r.sequence === `rn-repo${n}`).map(priced);
  const effort = (level: string, tokens: number): Folder => folderOf(root, `effort/${level}-p1`, seed1.filter((r) => r.sequence === 'rn-repo1' && r.position === 0 && r.arm !== 'S2').map((r) => setOutput({ ...r }, tokens)));
  const c: Corpus = {
    root, pilot: [folderOf(root, 'pilot/rn-repo1-p1', sequenceOf(1)), folderOf(root, 'pilot/rn-repo2-p1', sequenceOf(2))], low: effort('low', 1000), high: effort('high', 4000),
    prices: writeJson(path.join(root, 'prices.json'), PRICES_BY_MODEL), basis: writeJson(path.join(root, 'spend-basis.json'), SPEND), tasks: path.join(root, 'pilot-tasks'),
    pins: path.join(root, 'pins-r4.json'), pinsLow: path.join(root, 'pins-r4-effort-low.json'), pinsHigh: path.join(root, 'pins-r4-effort-high.json'),
  };
  for (const [file, effortLevel] of [[c.pins, 'medium'], [c.pinsLow, 'low'], [c.pinsHigh, 'high']] as const) writeJson(file, { ...PINS, effort: effortLevel });
  writeJson(path.join(c.tasks, 'rn-repo1', 'tasks-run.json'), tasksFile('rn-repo1', TASK_IDS, venvCheck()));
  writeJson(path.join(c.tasks, 'rn-repo2', 'tasks-run.json'), tasksFile('rn-repo2', TASK_IDS.map((t) => t.replace('repo1', 'repo2'))));
  writeJson(path.join(c.tasks, 'effort', 'tasks-run.json'), tasksFile('effort', ['effort-t0', 'effort-t1']));
  for (const arm of ['O1', 'S1', 'S2']) {
    put(c, arm, FIRST, first(c, arm));
    put(c, arm, SECOND, second(c, arm));
  }
  write(c);
  return c;
}

/** Saves every folder and writes each folder's off-pin file, bound to the pins file its run used. */
function write(c: Corpus, voids: readonly Void[] = []): void {
  for (const f of [...c.pilot, c.low, c.high]) save(f);
  c.pilot.forEach((f, i) => offPin(f, c.pins, i === 0 ? voids : []));
  offPin(c.low, c.pinsLow);
  offPin(c.high, c.pinsHigh);
}

function argv(c: Corpus): string[] {
  return [...c.pilot.flatMap((f) => ['--runs', runsOf(f), '--plan', planFileOf(f)]), '--effort-run', `low:${c.low.dir}`, '--effort-run', `high:${c.high.dir}`,
    ...[...c.pilot, c.low, c.high].flatMap((f) => ['--off-pin', offPinOf(f)]), '--prices', c.prices, '--spend-basis', c.basis, '--pilot-tasks', c.tasks, '--pins', c.pins,
    '--ledger-total', '40', '--pilot-spend', '36.5', '--attempt', '1', '--tag', 'z0-r4-freeze-1', '--out', path.join(c.root, 'pilot.json')];
}
const indexOfFlag = (args: readonly string[], flag: string, nth: number): number => args.flatMap((a, i) => (a === flag ? [i] : []))[nth]!;
const setFlag = (args: readonly string[], flag: string, value: string, nth = 0): string[] => args.map((a, i) => (i === indexOfFlag(args, flag, nth) + 1 ? value : a));
const dropFlag = (args: readonly string[], flag: string, nth = 0): string[] => args.filter((_, i) => i !== indexOfFlag(args, flag, nth) && i !== indexOfFlag(args, flag, nth) + 1);

const run = (c: Corpus, args: readonly string[] = argv(c)) => runCli([...args], c.root);
const pilotOf = (c: Corpus): PilotJson => JSON.parse(fs.readFileSync(path.join(c.root, 'pilot.json'), 'utf8'));
const linesOf = (text: string): string[] => text.split('\n').filter(Boolean);
const NAMES = ['off-pin', 'effort', 'venv', 'env-keys', 'cost-usd', 'r'];
const crashed = (r: Rec, reason = 'no-result'): Rec => {
  crash(r, reason);
  r.costUsd = null;
  return r;
};

/** The run exits 3 with PILOT FAIL for `name` alone, and pilot.json says the same. */
function expectOnlyFail(c: Corpus, name: string, reason: string | RegExp): void {
  const r = run(c);
  expect(r.code).toBe(3);
  expect(r.stderr.trim()).toBe(`PILOT FAIL: ${name}`);
  expect(linesOf(r.stdout).find((l) => l.startsWith(`check ${name} fail`))).toMatch(reason);
  expect(pilotOf(c).checks).toEqual(Object.fromEntries(NAMES.map((n) => [n, n === name ? 'fail' : 'pass'])));
}

/* ------------------------------------------------------------------------------------------------ cases */

describe('z0-pilot: the pass and the pilot.json it writes', () => {
  it('passes a whole corpus, prints the six checks in order and writes every field', () => {
    const c = build();
    find(c.pilot[0]!, 'S2', 4).hookCancels = { UserPromptSubmit: 3 };
    find(c.pilot[1]!, 'S2', 4).hookCancels = { Stop: 1 };
    write(c);
    const r = run(c);
    expect(r.code).toBe(0);
    const lines = linesOf(r.stdout);
    const at = NAMES.map((n) => lines.indexOf(`check ${n} pass`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(lines).toEqual(expect.arrayContaining([`effort ${SONNET}: low 1000, high 4000`, `effort ${OPUS}: low 1000, high 4000`, 'env-keys O1: 38 records, outside none', 'env-keys S2: 36 records, outside none',
      'cost-usd: 112 records, 0 outside 0.1%, 0 with no costUsd', 'r S1: 1', 'r S2: 1', 'r 1 from S1', 'hook-cancels O1 0 in 38 sessions', 'hook-cancels S2 4 in 36 sessions',
      `cells ${OPUS}: 36, invalid 0, timeout 0`, `cells ${SONNET}: 72, invalid 0, timeout 0`, 'pilot spend $36.50 of its $40 budget']));
    expect(lines.indexOf(`cells ${OPUS}: 36, invalid 0, timeout 0`)).toBeLessThan(lines.indexOf(`cells ${SONNET}: 72, invalid 0, timeout 0`));
    const pilot = pilotOf(c);
    expect(pilot).toMatchObject({ schema: 'z0-pilot/1', attempt: 1, tag: 'z0-r4-freeze-1', r: { S1: 1, S2: 1 }, rArm: 'S1', rMax: 1, flag19: false, ledgerTotal: 40, pilotSpend: 36.5, checks: Object.fromEntries(NAMES.map((n) => [n, 'pass'])) });
    const roles = new Set(pilot.hashes.map((h) => h.role));
    for (const role of ['runs', 'plan', 'prices', 'off-pin', 'effort-runs', 'pilot-tasks', 'pins', 'spend-basis', 'venv', 'source']) expect(roles.has(role)).toBe(true);
    expect(pilot.hashes.filter((h) => h.role === 'venv')).toHaveLength(6);
    expect(pilot.hashes.filter((h) => h.role === 'effort-runs')).toHaveLength(4);
    expect(pilot.hashes.filter((h) => h.role === 'off-pin')).toHaveLength(4);
    expect(pilot.hashes.find((h) => h.role === 'pilot-tasks')).toMatchObject({ file: c.tasks, tree: true });
    expect(pilot.hashes.find((h) => h.role === 'pins')!.sha256).toBe(sha(c.pins));
    expect(pilot.hashes.find((h) => h.role === 'spend-basis')!.sha256).toBe(sha(c.basis));
  });

  it('is read by z0-budget: the admit, the founder question and the report', () => {
    const c = build();
    const made = run(c);
    expect(made.code).toBe(0);
    const log = path.join(c.root, 'budget-log.jsonl');
    const admit = (): ReturnType<typeof budgetCli> => budgetCli(['admit', '--step', 'whole-run', '--attempt', '1', '--approved', '2140', '--ledger-total', '40', '--spend-basis', c.basis, '--pins', c.pins, '--log', log,
      '--pilot', path.join(c.root, 'pilot.json')], c.root);
    const ok = admit();
    expect(ok.code).toBe(0);
    const projections = linesOf(ok.stdout).filter((l) => l.startsWith('projection at r'));
    expect(projections).toHaveLength(2);
    for (const line of projections) expect(linesOf(made.stdout)).toContain(line);
    const report = budgetCli(['report', '--log', log, '--ledger-total', '40', '--approved', '2140', '--pins', c.pins, '--pilot', path.join(c.root, 'pilot.json')], c.root);
    expect(report.code).toBe(0);
    expect(linesOf(report.stdout)).toEqual(expect.arrayContaining(['pilot: $36.50 against $40', 'r S1: 1', 'r S2: 1']));

    const hot = build({ s2Cost: 2 });
    expect(run(hot).code).toBe(0);
    expect(pilotOf(hot)).toMatchObject({ r: { S1: 1, S2: 2 }, rArm: 'S2', rMax: 2, flag19: true });
    const refused = budgetCli(['admit', '--step', 'whole-run', '--attempt', '1', '--approved', '2140', '--ledger-total', '40', '--spend-basis', hot.basis, '--pins', hot.pins,
      '--log', path.join(hot.root, 'budget-log.jsonl'), '--pilot', path.join(hot.root, 'pilot.json')], hot.root);
    expect(refused.code).toBe(4);
    expect(refused.stderr.startsWith('FOUNDER: S2 has r')).toBe(true);
  });
});

describe('z0-pilot: one fail per check', () => {
  it('off-pin: one void', () => {
    const c = build();
    write(c, [{ sequence: 'rn-repo1', seed: 1, arm: 'S1', position: 4, sessionId: 'abc', reason: 'model claude-opus-5-5' }]);
    expectOnlyFail(c, 'off-pin', 'rn-repo1 seed 1 S1 position 4 model claude-opus-5-5');
  });

  it('effort: Sonnet\'s high output at or below its low, and a record with no usage', () => {
    const c = build();
    setOutput(find(c.high, 'S1', 0), 1000);
    write(c);
    expectOnlyFail(c, 'effort', SONNET);
    expect(linesOf(run(c).stdout)).toContain(`effort ${SONNET}: low 1000, high 1000`);
    const none = build();
    crashed(find(none.high, 'S1', 0));
    write(none);
    expectOnlyFail(none, 'effort', `${SONNET} at high has no usage`);
  });

  it('effort: a folder whose off-pin file names a pins file at another effort', () => {
    const c = build();
    offPin(c.low, c.pins);
    expectOnlyFail(c, 'effort', 'names a pins file at effort medium');
    const swapped = build();
    const args = setFlag(setFlag(argv(swapped), '--effort-run', `low:${swapped.high.dir}`, 0), '--effort-run', `high:${swapped.low.dir}`, 1);
    const r = run(swapped, args);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('names a pins file at effort high');
  });

  it('env-keys: a name outside the round 4 allowlist, uppercased before the test', () => {
    const c = build();
    find(c.pilot[0]!, 'S1', 7).envKeys = [...ENV_KEYS, 'ANTHROPIC_API_KEY'];
    find(c.pilot[1]!, 'O1', 7).envKeys = [...ENV_KEYS, 'pip_constraint', 'anthropic_api_key'];
    write(c);
    expectOnlyFail(c, 'env-keys', 'ANTHROPIC_API_KEY');
    expect(linesOf(run(c).stdout)).toEqual(expect.arrayContaining(['env-keys S1: 38 records, outside ANTHROPIC_API_KEY', 'env-keys O1: 38 records, outside ANTHROPIC_API_KEY', 'env-keys S2: 36 records, outside none']));
  });

  it('cost-usd: 0.2% over fails, 0.09% over passes, null usage with a costUsd fails, and no costUsd at all fails', () => {
    const c = build();
    const rec = find(c.pilot[0]!, 'S1', 7);
    rec.costUsd = price(rec) * 1.002;
    write(c);
    expectOnlyFail(c, 'cost-usd', '1 of 112 records are outside 0.1%');
    const out = linesOf(run(c).stdout);
    expect(out).toContain('cost-usd: 112 records, 1 outside 0.1%, 0 with no costUsd');
    expect(out.some((l) => l.includes(`${runsOf(c.pilot[0]!)} line`) && l.includes(`costUsd ${rec.costUsd}, priced ${price(rec)}`))).toBe(true);
    rec.costUsd = price(rec) * 1.0009;
    write(c);
    expect(run(c).code).toBe(0);
    const bare = build();
    const crashedOne = crashed(find(bare.pilot[0]!, 'S1', 7));
    crashedOne.costUsd = 1;
    write(bare);
    expectOnlyFail(bare, 'cost-usd', '1 of 112 records are outside 0.1%');
    expect(linesOf(run(bare).stdout).some((l) => l.endsWith('has a costUsd and no usage'))).toBe(true);
    const none = build();
    for (const f of [...none.pilot, none.low, none.high]) for (const r of f.records) r.costUsd = null;
    write(none);
    expectOnlyFail(none, 'cost-usd', 'no record has a costUsd');
  });

  it('r: no base record with usage fails, writes a null rMax and projects nothing', () => {
    const c = build();
    for (const f of c.pilot) for (const r of f.records.filter((x) => x.arm === 'O1')) crashed(r);
    write(c);
    expectOnlyFail(c, 'r', 'no task both S1 and O1 ran with usage');
    const r = run(c);
    expect(linesOf(r.stdout)).toContain('projection: no r');
    expect(pilotOf(c)).toMatchObject({ r: { S1: null, S2: null }, rArm: null, rMax: null, flag19: false });
    expect(linesOf(r.stdout).some((l) => l.startsWith('whole-run at r'))).toBe(false);
  });
});

describe('z0-pilot: the venv check', () => {
  const base = (): Corpus => build();
  const rejects = (c: Corpus, reason: string): void => {
    expectOnlyFail(c, 'venv', reason);
  };

  it('a first task without the package fails: planted package not installed', () => {
    const c = base();
    put(c, 'S1', FIRST, edit(first(c, 'S1'), 'packages', 'pip'));
    rejects(c, 'planted package not installed');
  });

  it('a first task without import_six=ok fails: planted package does not import', () => {
    const c = base();
    put(c, 'O1', FIRST, edit(first(c, 'O1'), 'import_six', 'fail'));
    rejects(c, 'planted package does not import');
  });

  it.each([['packages', 'pip,six'], ['packages_end', 'pip,six==1.17.0']])('a second task with the package in %s fails: planted package in the second task', (key, value) => {
    const c = base();
    put(c, 'S2', SECOND, edit(second(c, 'S2'), key, value));
    rejects(c, 'planted package in the second task');
  });

  it('a second task with no packages_end fails', () => {
    const c = base();
    put(c, 'S2', SECOND, edit(second(c, 'S2'), 'packages_end', null));
    rejects(c, 'has no packages_end');
  });

  it('a second task without import_six=fail fails: planted package imports in the second task', () => {
    const c = base();
    put(c, 'S1', SECOND, edit(second(c, 'S1'), 'import_six', 'ok'));
    rejects(c, 'planted package imports in the second task');
  });

  it.each([['first', FIRST, 5], ['second', SECOND, 3]] as const)('a %s task whose prefix is another position\'s venv fails', (which, task, position) => {
    const c = base();
    const kv = which === 'first' ? first(c, 'O1') : second(c, 'O1');
    put(c, 'O1', task, edit(kv, 'prefix', prefixOf(c, 'O1', position)));
    rejects(c, 'prefix');
  });

  it('a missing venv file fails and is named', () => {
    const c = base();
    const unwritten = 'rn-repo1-t9';
    writeJson(path.join(c.tasks, 'rn-repo1', 'tasks-run.json'), tasksFile('rn-repo1', TASK_IDS, venvCheck({ second: unwritten })));
    rejects(c, `${venvPath(c, 'S2', unwritten)} is missing`);
  });

  it('reads names lowercased and without their version, in both lists', () => {
    const c = base();
    put(c, 'S1', FIRST, edit(first(c, 'S1'), 'packages', 'Pip, Six==1.17.0'));
    put(c, 'S2', SECOND, edit(edit(second(c, 'S2'), 'packages', 'pip pytest==8.0'), 'packages_end', 'pip,pytest'));
    expect(run(c).code).toBe(0);
    put(c, 'O1', SECOND, edit(second(c, 'O1'), 'packages_end', 'pip,SIX'));
    rejects(c, 'planted package in the second task');
  });

  it('a line with no = and a key given twice fail, naming the file and line', () => {
    const c = base();
    fs.writeFileSync(venvPath(c, 'S1', FIRST), `${first(c, 'S1').map(([k, v]) => `${k}=${v}`).join('\n')}\nbroken line\npackages=six\n`);
    expectOnlyFail(c, 'venv', `${venvPath(c, 'S1', FIRST)} line 6`);
    expect(run(c).stdout).toContain(`${venvPath(c, 'S1', FIRST)} line 7 repeats packages`);
  });

  it('the second task planned before the first fails', () => {
    const c = base();
    writeJson(path.join(c.tasks, 'rn-repo1', 'tasks-run.json'), tasksFile('rn-repo1', [...TASK_IDS.slice(0, 3), SECOND, ...TASK_IDS.slice(3, 5), ...TASK_IDS.slice(6)], venvCheck({ first: SECOND, second: FIRST })));
    rejects(c, 'the second task ran before the first');
  });
});

describe('z0-pilot: r and its flag', () => {
  const FLAG = (arm: string): string => `on the pilot tasks ${arm}'s cost per task is ${R_FLAG / 2} of Opus's or more before any saving`;

  it('names the arm at 1.9 or more and no arm below it', () => {
    const hot = rSummary({ S1: 1.9, S2: 1 });
    expect(hot).toEqual({ rMax: 1.9, rArm: 'S1', flag19: true, lines: ['r S1: 1.9', 'r S2: 1', 'r 1.9 from S1', FLAG('S1')] });
    expect(FLAG('S1')).toContain('0.95');
    const cool = rSummary({ S1: 1.89, S2: 1 });
    expect(cool).toEqual({ rMax: 1.89, rArm: 'S1', flag19: false, lines: ['r S1: 1.89', 'r S2: 1', 'r 1.89 from S1'] });
  });

  it('prints one line per arm at the flag, takes the larger r and the design-order first on a tie', () => {
    expect(rSummary({ S1: 2, S2: 2 })).toMatchObject({ rMax: 2, rArm: 'S1', lines: expect.arrayContaining([FLAG('S1'), FLAG('S2')]) });
    expect(rSummary({ S1: 1.9, S2: 2.5 })).toMatchObject({ rMax: 2.5, rArm: 'S2', flag19: true });
    expect(rSummary({ S1: 1.9, S2: 2.5 }).lines.filter((l) => l.startsWith('on the pilot tasks'))).toHaveLength(2);
  });

  it('gives a null rMax, rArm and no flag when an r is null', () => {
    expect(rSummary({ S1: null, S2: 2.4 })).toEqual({ rMax: null, rArm: null, flag19: false, lines: ['r S1: null', 'r S2: 2.4'] });
  });

  it('prints the line from the CLI for an arm at twice the base and not at 1.5 times', () => {
    for (const [cost, flagged] of [[2, true], [1.5, false]] as const) {
      const c = build({ s2Cost: cost });
      const out = linesOf(run(c).stdout);
      expect(out.some((l) => l.startsWith('on the pilot tasks S2'))).toBe(flagged);
      expect(pilotOf(c).flag19).toBe(flagged);
    }
  });
});

describe('z0-pilot: cells, spend and the whole-run line', () => {
  it('counts the invalid, timed-out and leaked cells of each model by hand', () => {
    const c = build();
    crashed(find(c.pilot[0]!, 'O1', 6));
    crashed(find(c.pilot[1]!, 'O1', 9));
    crashed(find(c.pilot[0]!, 'S1', 6));
    Object.assign(find(c.pilot[1]!, 'S2', 10), { timedOut: true, resolved: false });
    const leak = crashed(find(c.pilot[1]!, 'S2', 12), 'leak');
    leak.leak = true;
    write(c);
    const r = run(c);
    expect({ code: r.code, error: r.stderr.split('\n')[0] }).toEqual({ code: 0, error: '' });
    expect(linesOf(r.stdout)).toEqual(expect.arrayContaining([`cells ${OPUS}: 36, invalid 2, timeout 0`, `cells ${SONNET}: 72, invalid 1, timeout 1`]));
  });

  it('prints the above-budget line at 40.01 and still exits 0, and none at 40.00', () => {
    const c = build();
    const over = run(c, setFlag(argv(c), '--pilot-spend', '40.01'));
    expect(over.code).toBe(0);
    expect(linesOf(over.stdout)).toContain('pilot spend $40.01 of its $40 budget; above its $40 budget');
    const exact = run(c, setFlag(argv(c), '--pilot-spend', '40.00'));
    expect(linesOf(exact.stdout)).toContain('pilot spend $40.00 of its $40 budget');
    expect(exact.stdout).not.toContain('above its');
    expect(pilotOf(c).pilotSpend).toBe(40);
  });

  it.each(['5', '4'])('follows wholeRunSeeds %s: three projection lines and the figure the check needs', (seeds) => {
    const c = build();
    writeJson(c.pins, { ...PINS, wholeRunSeeds: seeds });
    write(c);
    const r = run(c);
    expect(r.code).toBe(0);
    const pins = readPins(c.pins);
    expect(wholeRunSeeds(pins)).toBe(Number(seeds));
    const gapByArm = sequenceGap(SPEND.bySequence, listOf(pins, 'batch1Keys'));
    const at = (n: number): number => wholeRun({ basisByArm: readBasis(c.basis).basisByArm, gapByArm, r: 1, seeds: n });
    const lines = linesOf(r.stdout);
    for (const n of [3, Number(seeds), 9]) expect(lines).toContain(`projection at r 1, ${n} seeds: $${at(n).toFixed(2)}`);
    expect(lines).toContain(`whole-run at r 1, ${seeds} seeds: $${at(Number(seeds)).toFixed(2)}; the check needs $${(40 + GATE_MARGIN * at(Number(seeds))).toFixed(2)}`);
  });
});

describe('z0-pilot: missing evidence is bad input', () => {
  const stops = (c: Corpus, text: string, args: readonly string[] = argv(c)): void => {
    const r = run(c, args);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(text);
    expect(r.stderr.split('usage: z0-pilot.mjs').length - 1).toBe(1);
    expect(fs.existsSync(path.join(c.root, 'pilot.json'))).toBe(false);
  };

  it('a session record with no hookCancels, or a negative count', () => {
    const c = build();
    delete find(c.pilot[0]!, 'S2', 5).hookCancels;
    write(c);
    stops(c, `${runsOf(c.pilot[0]!)} line`);
    expect(run(c).stderr).toContain('hookCancels');
    const negative = build();
    find(negative.pilot[1]!, 'O1', 5).hookCancels = { UserPromptSubmit: -1 };
    write(negative);
    stops(negative, 'hookCancels.UserPromptSubmit');
  });

  it('a record with no envKeys', () => {
    const c = build();
    delete find(c.pilot[0]!, 'O1', 5).envKeys;
    write(c);
    stops(c, 'envKeys');
  });

  it('a record with neither surfaceRestored nor an invalid reason, and an invalid one with neither', () => {
    const c = build();
    delete find(c.pilot[0]!, 'S1', 5).surfaceRestored;
    write(c);
    stops(c, 'no surfaceRestored and no invalid reason');
    const ok = build();
    const setup = crashed(find(ok.pilot[0]!, 'S1', 5), 'setup');
    delete setup.surfaceRestored;
    delete setup.hookCancels;
    write(ok);
    expect(run(ok).code).toBe(0);
  });

  it('a runs file no off-pin file names, and an off-pin file that names an unloaded runs file', () => {
    const c = build();
    stops(c, runsOf(c.low), dropFlag(argv(c), '--off-pin', 2));
    const stray = folderOf(c.root, 'stray', [{ ...find(c.pilot[1]!, 'O1', 0) }]);
    save(stray);
    offPin(c.pilot[0]!, c.pins, [], [stray]);
    stops(c, 'is not a runs file this read loads');
  });

  it('a plan cell with no record, and a torn runs line', () => {
    const c = build();
    c.pilot[0]!.records = c.pilot[0]!.records.filter((r) => !(r.arm === 'S2' && r.position === 9));
    write(c);
    stops(c, `${c.pilot[0]!.dir} is not done: cell rn-repo1#1@9/S2 has no record`);
    const torn = build();
    fs.appendFileSync(runsOf(torn.pilot[0]!), '{"schema":"z0-rec');
    stops(torn, `${runsOf(torn.pilot[0]!)} line`);
  });

  it('an effort folder with no S1 record, and one with two base records', () => {
    const c = build();
    c.low.records = c.low.records.filter((r) => r.arm !== 'S1');
    c.low.cells = c.low.cells.filter((x) => x.arm !== 'S1');
    write(c);
    stops(c, 'effort');
    const two = build();
    const copy = { ...find(two.high, 'O1', 0), position: 1, taskId: 'rn-repo1-t1' };
    two.high.records.push(copy);
    two.high.cells = planOf(two.high.records);
    write(two);
    stops(two, 'one record per arm');
  });

  it('two venvCheck files, none, and a sequence no pilot plan holds', () => {
    const two = build();
    writeJson(path.join(two.tasks, 'rn-repo2', 'tasks-run.json'), tasksFile('rn-repo2', TASK_IDS.map((t) => t.replace('repo1', 'repo2')), venvCheck({ sequence: 'rn-repo2', first: 'rn-repo2-t3', second: 'rn-repo2-t5' })));
    stops(two, 'exactly one');
    const none = build();
    writeJson(path.join(none.tasks, 'rn-repo1', 'tasks-run.json'), tasksFile('rn-repo1', TASK_IDS));
    stops(none, 'exactly one');
    const orphan = build();
    writeJson(path.join(orphan.tasks, 'rn-repo1', 'tasks-run.json'), { sequences: [{ id: 'rn-repo1', cluster: 'c', repo: 'r', tasks: TASK_IDS.map((id) => ({ id })) }, { id: 'rn-extra', cluster: 'c', repo: 'r', tasks: [{ id: 'x1' }, { id: 'x2' }] }],
      venvCheck: venvCheck({ sequence: 'rn-extra', first: 'x1', second: 'x2' }) });
    stops(orphan, 'no pilot plan holds cells of venvCheck.sequence rn-extra');
  });

  it('a pilot folder that misses an arm, and a runs file given twice', () => {
    const c = build();
    c.pilot[1]!.records = c.pilot[1]!.records.filter((r) => r.arm !== 'S2');
    c.pilot[1]!.cells = c.pilot[1]!.cells.filter((x) => x.arm !== 'S2');
    write(c);
    stops(c, 'a pilot folder holds exactly O1, S1, S2');
    const twice = build();
    stops(twice, `${runsOf(twice.pilot[1]!)} is given twice`, [...argv(twice), '--runs', runsOf(twice.pilot[1]!), '--plan', planFileOf(twice.pilot[1]!)]);
  });

  it('a pilot folder whose off-pin file names another pins file', () => {
    const c = build();
    offPin(c.pilot[1]!, c.pinsLow);
    stops(c, `is not the --pins file's ${sha(c.pins)}`);
  });

  it('a venvCheck of the wrong form', () => {
    const c = build();
    writeJson(path.join(c.tasks, 'rn-repo1', 'tasks-run.json'), tasksFile('rn-repo1', TASK_IDS, venvCheck({ package: '' })));
    stops(c, 'venvCheck.package');
    writeJson(path.join(c.tasks, 'rn-repo1', 'tasks-run.json'), tasksFile('rn-repo1', TASK_IDS, venvCheck({ second: 'rn-repo1-t99' })));
    stops(c, 'rn-repo1-t99');
  });

  it('a pins file that is not an object, and a spend basis with no q145 row', () => {
    const c = build();
    fs.writeFileSync(c.pins, '[1]\n');
    stops(c, `${c.pins} must be a JSON object`);
    fs.writeFileSync(c.pins, 'null\n');
    stops(c, `${c.pins}`);
    const basis = build();
    writeJson(basis.basis, { ...SPEND, bySequence: { q12: SPEND.bySequence.q12, q140: SPEND.bySequence.q140 } });
    stops(basis, 'q145');
  });
});

describe('z0-pilot: the flags', () => {
  const flagStops = (c: Corpus, args: readonly string[]): void => {
    const r = run(c, args);
    expect(r.code).toBe(1);
    expect(r.stderr.split('usage: z0-pilot.mjs').length - 1).toBe(1);
  };

  it('stops with the usage on each bad flag', () => {
    const c = build();
    const a = argv(c);
    flagStops(c, setFlag(a, '--pins', ''));
    flagStops(c, setFlag(a, '--tag', '  '));
    flagStops(c, a.slice(0, -1));
    flagStops(c, setFlag(a, '--effort-run', `mid:${c.low.dir}`));
    flagStops(c, setFlag(a, '--effort-run', `low:${c.high.dir}`, 1));
    flagStops(c, setFlag(a, '--effort-run', c.low.dir));
    flagStops(c, dropFlag(a, '--effort-run', 1));
    flagStops(c, setFlag(a, '--attempt', '0'));
    flagStops(c, setFlag(a, '--ledger-total', 'abc'));
    flagStops(c, setFlag(a, '--pilot-spend', '-1'));
    flagStops(c, [...a, '--bogus', 'x']);
    flagStops(c, dropFlag(a, '--plan', 1));
    flagStops(c, setFlag(a, '--plan', planFileOf(c.low), 0));
    flagStops(c, [0, 1, 2, 3].reduce((args) => dropFlag(args, '--off-pin', 0), a));
    expect(fs.existsSync(path.join(c.root, 'pilot.json'))).toBe(false);
  });

  it('accepts a Windows path after the effort label, split at the first colon', () => {
    const c = build();
    const label = `low:${c.low.dir}`;
    expect(label.indexOf(':')).toBe(3);
    expect(run(c, setFlag(argv(c), '--effort-run', label)).code).toBe(0);
  });

});

describe('z0-budget exports (plan W3-1)', () => {
  it('exports the margin, the flag and the three readers the pilot uses', () => {
    expect(GATE_MARGIN).toBe(1.25);
    expect(R_FLAG).toBe(1.9);
    for (const f of [readBasis, readPins, listOf, wholeRunSeeds]) expect(f).toBeInstanceOf(Function);
    expect(DESIGNS.r4.pairs.S1vO1).toEqual(['S1', 'O1']);
  });
});
