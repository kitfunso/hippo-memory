/** Z0 cost by kind pure parts: the kind filters, the pairs, the hash checks, the self-check compare, the cell rows and the text print. */
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KINDS, PAIRS, checkCells, checkSources, costByKind, fieldsOff, formatText, inputArgs, parseArgs, selfCheck } from '../../scripts/token-eval/z0-cost-by-kind.mjs';

interface Rec { arm: string; sequence: string; seed: number; position: number; set: string; kind: string; applyIndex: number | null; cost: number }
interface Hash { role: string; file: string; sha256: string }
interface Est { estimate: number; low: number; high: number; se: number; df: number; p: number }
interface Cell {
  pair: string; seeds: string; kind: string; units: number; ratio: number | null | undefined; low: number | null; high: number | null; p: number | null | undefined;
  se: number | null; df: number | null; dollarsT: number | null; dollarsC: number | null; dollarsDiff: number | null;
  resolve: { estimate: number | null; low: number | null; high: number | null; p: number | null };
}
interface Label { root: string; sha: string; clean: boolean | null; node: string; sources: number }

const messageOf = (run: () => void): string => {
  try {
    run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '';
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const nextUp = (x: number): number => {
  const f = new Float64Array([x]);
  new BigUint64Array(f.buffer)[0]! += 1n;
  return f[0]!;
};
const EST = { estimate: 1.0057, low: 0.9639, high: 1.0493, se: 0.0215, df: 248.2, p: 0.7908 };

describe('Z0 cost by kind: kinds and pairs', () => {
  const rec = (set: string, kind: string, applyIndex: number | null): Rec => ({ arm: 'A2', sequence: 'seq', seed: 1, position: 0, set, kind, applyIndex, cost: 1 });
  // The last four sit outside sets R and N, or outside teach and apply, with an apply slot that tempts a filter missing its kind or set check.
  const RECORDS = [
    rec('R', 'teach', null), rec('R', 'apply', 1), rec('R', 'apply', 2), rec('R', 'apply', 3), rec('N', 'apply', null), rec('X', 'apply', 1),
    rec('X', 'teach', null), rec('X', 'apply', 2), rec('R', 'review', 1), rec('R', 'review', 2),
  ];

  it('splits sets R and N with no overlap and no gap, and leaves set X and other kinds out', () => {
    const hits = RECORDS.map((r) => Object.entries(KINDS).filter(([, keep]) => keep(r)).map(([name]) => name));
    expect(hits).toEqual([['teach'], ['first apply'], ['later apply'], ['later apply'], ['set N'], [], [], [], [], []]);
  });

  it('holds the seven pairs, three on all seeds and four labelled seeds 1-2', () => {
    expect(PAIRS).toEqual([
      ['A2', 'A1', 'all'], ['A5', 'A1', 'all'], ['A2', 'A5', 'all'],
      ['A4', 'A1', 's1-2'], ['A0', 'A1', 's1-2'], ['A2', 'A1', 's1-2'], ['A5', 'A1', 's1-2'],
    ]);
  });
});

describe('Z0 cost by kind: fieldsOff', () => {
  it('gives no field for equal estimates, whatever else they carry', () => {
    expect(fieldsOff(EST, { ...EST, bootstrap: { low: 0 }, iterations: 10_000 })).toEqual([]);
  });

  it('names each field that moves by one ulp, in the self-check order', () => {
    expect(fieldsOff({ ...EST, p: nextUp(EST.p) }, EST)).toEqual(['p']);
    expect(fieldsOff({ ...EST, estimate: nextUp(EST.estimate), df: nextUp(EST.df) }, EST)).toEqual(['estimate', 'df']);
  });

  it('counts a missing field as different, never as equal', () => {
    expect(fieldsOff({ estimate: 1, low: 1, high: 1, p: 1 }, { estimate: 1, low: 1, high: 1, se: 0, df: 3, p: 1 })).toEqual(['se', 'df']);
  });
});

describe('Z0 cost by kind: hash checks', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  function tmp(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-kind-'));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
  }
  const entry = (dir: string, role: string, name: string, text: string): Hash => ({ role, file: path.join(dir, name), sha256: sha(text) });
  const FILES = { 'a.jsonl': 'run a', 'b.jsonl': 'run b', 'p1.json': 'plan 1', 'p2.json': 'plan 2', 'prices.json': '{}', 'grading.json': '{"g":1}', 'drop.json': '{"d":1}' };
  function hashes(dir: string): Hash[] {
    return [
      entry(dir, 'prices', 'prices.json', FILES['prices.json']), entry(dir, 'grading', 'grading.json', FILES['grading.json']),
      entry(dir, 'drop-list', 'drop.json', FILES['drop.json']), entry(dir, 'runs', 'b.jsonl', FILES['b.jsonl']),
      entry(dir, 'runs', 'a.jsonl', FILES['a.jsonl']), entry(dir, 'plan', 'p2.json', FILES['p2.json']), entry(dir, 'plan', 'p1.json', FILES['p1.json']),
    ];
  }
  const given = (dir: string) => ({ grading: path.join(dir, 'grading.json'), dropList: path.join(dir, 'drop.json') });

  it('builds the analyzer args with runs and plan in the report order and the analyzer defaults left off', () => {
    const dir = tmp(FILES);
    expect(inputArgs(hashes(dir), given(dir))).toEqual({
      runs: [path.join(dir, 'b.jsonl'), path.join(dir, 'a.jsonl')], plan: [path.join(dir, 'p2.json'), path.join(dir, 'p1.json')],
      prices: path.join(dir, 'prices.json'), grading: path.join(dir, 'grading.json'), dropList: path.join(dir, 'drop.json'),
      key: null, out: null, seed: null, iterations: null, unblind: false, help: false,
    });
  });

  it('throws on a changed input, naming the file, both hashes and the fix', () => {
    const dir = tmp({ ...FILES, 'a.jsonl': 'run a edited' });
    expect(() => inputArgs(hashes(dir).map((h) => (h.file.endsWith('a.jsonl') ? { ...h, sha256: sha('run a') } : h)), given(dir)))
      .toThrow(new RegExp(`runs file .*a\\.jsonl has sha256 ${sha('run a edited')}, the report recorded ${sha('run a')}; restore the file`));
  });

  it('throws on a missing input, naming the file and its recorded hash', () => {
    const dir = tmp({ ...FILES });
    const list = hashes(dir);
    fs.rmSync(path.join(dir, 'p1.json'));
    expect(() => inputArgs(list, given(dir))).toThrow(new RegExp(`plan file .*p1\\.json is missing \\(the report recorded ${sha('plan 1')}\\)`));
  });

  it('checks --grading and --drop-list against the report, not the report paths', () => {
    const dir = tmp(FILES);
    const edited = tmp({ 'grading.json': '{"g":2}', 'drop.json': FILES['drop.json'] });
    expect(() => inputArgs(hashes(dir), { grading: path.join(edited, 'grading.json'), dropList: path.join(edited, 'drop.json') }))
      .toThrow(/--grading .*grading\.json has sha256 .*, the report recorded .*; pass the grading file round 3 read/);
    expect(() => inputArgs(hashes(dir), { grading: path.join(dir, 'grading.json'), dropList: path.join(edited, 'grading.json') }))
      .toThrow(/--drop-list .*grading\.json has sha256 .*; pass the drop list round 3 read/);
    const copy = tmp({ 'grading.json': FILES['grading.json'], 'drop.json': FILES['drop.json'] });
    const args = inputArgs(hashes(dir), { grading: path.join(copy, 'grading.json'), dropList: path.join(copy, 'drop.json') });
    expect([args.grading, args.dropList]).toEqual([path.join(copy, 'grading.json'), path.join(copy, 'drop.json')]);
  });

  it('stops when the report lacks the prices, grading or drop-list hash', () => {
    const dir = tmp(FILES);
    expect(() => inputArgs(hashes(dir).filter((h) => h.role !== 'grading'), given(dir))).toThrow(/lists 0 grading hashes/);
  });

  it('counts the sources it checked and throws on a changed or missing one', () => {
    const dir = tmp({ 'scripts/one.mjs': 'one', 'dist/two.js': 'two' });
    const list = [entry(dir, 'source', 'x', 'one'), entry(dir, 'source', 'x', 'two'), entry(dir, 'runs', 'x', 'ignored')]
      .map((h, i) => ({ ...h, file: ['scripts/one.mjs', 'dist/two.js', 'a.jsonl'][i]! }));
    expect(checkSources(dir, list)).toBe(2);
    fs.writeFileSync(path.join(dir, 'dist/two.js'), 'two!');
    expect(() => checkSources(dir, list)).toThrow(new RegExp(`dist/two\\.js under --analyzer .* has sha256 ${sha('two!')}, the report recorded ${sha('two')}; check out 04835462b .* npm run build`));
    fs.rmSync(path.join(dir, 'scripts/one.mjs'));
    expect(() => checkSources(dir, list)).toThrow(/scripts\/one\.mjs is missing under --analyzer/);
    expect(() => checkSources(dir, [])).toThrow(/lists no source hashes/);
  });
});

describe('Z0 cost by kind: selfCheck', () => {
  const GOT = { estimate: 1.5, low: 1, high: 2, se: 0.1, df: 9, p: 0.5 };
  const WANT = { ...GOT, iterations: 0, bootstrap: { low: 0 } };
  const api = {
    taskUnits: () => [],
    ratioT: () => GOT,
    harmT: () => ({ costRatio: GOT, resolveDiff: GOT }),
    inSets: () => () => true,
    maintainer: () => true,
  };
  const H4 = { costRatio: WANT, resolveDiff: WANT };
  const report = (hypotheses: string | { H3: Est; H4: typeof H4 } = { H3: WANT, H4 }) => ({ hypotheses, reported: { maintainerOnly: { H3: WANT } } });

  it('returns the six compared fields of each of the three checks when all are exact', () => {
    expect(selfCheck(api, { scored: [] }, {}, report())).toEqual({ H3: GOT, maintainerOnlyH3: GOT, H4: { costRatio: GOT, resolveDiff: GOT } });
  });

  it('throws naming the check, the fields, got and want, and the node version', () => {
    const bad = report({ H3: { ...WANT, se: nextUp(GOT.se) }, H4 });
    const message = messageOf(() => selfCheck(api, { scored: [] }, {}, bad));
    expect(message).toContain('self-check H3 differs from the report in se');
    expect(message).toContain(`se: got ${GOT.se}, want ${nextUp(GOT.se)}`);
    expect(message).toContain(process.version);
    expect(message).not.toContain('estimate:');
    expect(message).toContain('every file matched its hash, so the cause is another Node version (a last-digit difference) or a changed call in this script (the filterRecords options or the prices key)');
  });

  it('throws when the report has no block to compare, instead of reading a string as an estimate', () => {
    expect(() => selfCheck(api, { scored: [] }, {}, report('withheld: invalid run (G1)'))).toThrow(/no H3 block; pass an unblinded report/);
  });
});

describe('Z0 cost by kind: checkCells', () => {
  const H3 = { estimate: 1.5, low: 1, high: 2, se: 0.1, df: 9, p: 0.5 };
  const NSET = { estimate: 1.1, low: 0.9, high: 1.3, se: 0.2, df: 7, p: 0.3 };
  const checks = { H3, H4: { costRatio: NSET } };
  const cell = (kind: string, e: Est, over: Partial<Cell> = {}): Cell => ({
    pair: 'A2/A1', seeds: 'all', kind, units: 5, ratio: e.estimate, low: e.low, high: e.high, p: e.p, se: e.se, df: e.df,
    dollarsT: 2, dollarsC: 1, dollarsDiff: 1, resolve: { estimate: 0, low: 0, high: 0, p: 1 }, ...over,
  });
  const good = [cell('sets R+N', H3), cell('teach', NSET), cell('set N', NSET)];

  it('passes when the whole-set row is H3 and the set N row is the H4 cost ratio, whatever other pairs hold', () => {
    const decoys = [cell('sets R+N', NSET, { seeds: 's1-2' }), cell('sets R+N', NSET, { pair: 'A5/A1' }), cell('set N', H3, { seeds: 's1-2' })];
    expect(() => checkCells([...decoys, ...good], checks)).not.toThrow();
  });

  it('throws on a one-ulp miss in the whole-set row, with the same got and want shape as the self-check', () => {
    const rows = [cell('sets R+N', H3, { df: nextUp(H3.df) }), ...good.slice(1)];
    const message = messageOf(() => checkCells(rows, checks));
    expect(message).toContain('cell A2/A1 all sets R+N against H3 differs from the report in df');
    expect(message).toContain(`df: got ${nextUp(H3.df)}, want ${H3.df}`);
    expect(message).toContain(process.version);
    expect(message).toContain('report this rather than rerun');
  });

  it('throws on a miss in the set N row, and on a null field where round 3 has a number', () => {
    expect(() => checkCells([good[0]!, cell('set N', NSET, { p: nextUp(NSET.p) })], checks)).toThrow(/cell A2\/A1 all set N against H4 cost ratio differs from the report in p/);
    expect(() => checkCells([cell('sets R+N', H3, { se: null }), good[2]!], checks)).toThrow(/against H3 differs from the report in se/);
  });

  it('throws when the plan left A2/A1 out, instead of reading no cell as a match', () => {
    expect(() => checkCells(good.filter((r) => r.kind !== 'set N'), checks)).toThrow(/no A2\/A1 all-seed set N cell/);
  });
});

describe('Z0 cost by kind: costByKind', () => {
  const rec = (arm: string, seed: number, position: number, set: string, kind: string, applyIndex: number | null): Rec => ({ arm, sequence: 'seq', seed, position, set, kind, applyIndex, cost: 1 });
  const RECORDS = ['A1', 'A2'].flatMap((arm) => [1, 2, 3].flatMap((seed) => [
    rec(arm, seed, 0, 'R', 'teach', null), rec(arm, seed, 1, 'R', 'apply', 1), rec(arm, seed, 2, 'R', 'apply', 2), rec(arm, seed, 3, 'N', 'apply', null),
  ]));
  const ONE = { estimate: 1, low: 0.9, high: 1.1, p: 0.5, se: 0.05, df: 12 };
  function stub(estimate: Partial<Est> = ONE) {
    const pairTasks = (scored: Rec[], armT: string, armC: string) => scored.filter((t) => t.arm === armT)
      .map((t) => ({ t, c: scored.find((c) => c.arm === armC && c.seed === t.seed && c.position === t.position)! }));
    return {
      pairTasks,
      inSets: (...sets: string[]) => (r: Rec) => sets.includes(r.set),
      taskUnits: (scored: Rec[], armT: string, armC: string, prices: Record<string, number>, keep: (r: Rec) => boolean) => pairTasks(scored, armT, armC)
        .filter(({ t }) => keep(t)).map(({ t, c }) => ({ t: { cost: t.cost * 2 }, c: { cost: c.cost } })),
      harmT: () => ({ costRatio: estimate, resolveDiff: { estimate: 0.25, low: 0, high: 0.5, p: 0.1 } }),
    };
  }

  it('skips a pair when either arm is not in the plan, and reads five rows for each pair that is', () => {
    const rows = costByKind(stub(), { arms: ['A1', 'A2'], scored: RECORDS }, {});
    expect([...new Set(rows.map((r: { pair: string; seeds: string }) => `${r.pair} ${r.seeds}`))]).toEqual(['A2/A1 all', 'A2/A1 s1-2']);
    expect(rows.map((r: { kind: string }) => r.kind).slice(0, 5)).toEqual(['sets R+N', 'teach', 'first apply', 'later apply', 'set N']);
  });

  it('counts units and sums dollars per cell, and the seeds 1-2 cell leaves seed 3 out', () => {
    const rows = costByKind(stub(), { arms: ['A1', 'A2'], scored: RECORDS }, {});
    const cell = (seeds: string, kind: string) => rows.find((r: { seeds: string; kind: string }) => r.seeds === seeds && r.kind === kind);
    expect(cell('all', 'sets R+N')).toMatchObject({ units: 12, dollarsT: 24, dollarsC: 12, dollarsDiff: 12 });
    expect(cell('s1-2', 'sets R+N')).toMatchObject({ units: 8, dollarsT: 16, dollarsC: 8, dollarsDiff: 8 });
    expect(cell('all', 'later apply')).toMatchObject({ units: 3, ratio: 1, resolve: { estimate: 0.25, low: 0, high: 0.5, p: 0.1 } });
  });

  it('turns a NaN or missing field into null and goes on', () => {
    const rows = costByKind(stub({ estimate: Number.NaN, low: Number.NaN, high: Number.NaN, p: Number.NaN }), { arms: ['A1', 'A2'], scored: RECORDS }, {});
    expect(rows[0]).toMatchObject({ ratio: null, low: null, high: null, p: null, se: null, df: null, dollarsT: 24 });
    expect(JSON.parse(JSON.stringify(rows[0])).df).toBeNull();
  });

  it('throws when the four kinds miss a task of sets R and N', () => {
    const odd = RECORDS.map((r) => (r.arm === 'A2' && r.seed === 1 && r.position === 0 ? { ...r, kind: 'warmup' } : r));
    expect(() => costByKind(stub(), { arms: ['A1', 'A2'], scored: odd.map((r) => (r.arm === 'A1' && r.seed === 1 && r.position === 0 ? { ...r, kind: 'warmup' } : r)) }, {}))
      .toThrow(/A2\/A1 all: the four kinds hold 11 units and sets R\+N holds 12, so a task sits outside every kind; the scored records cannot be cut by kind, so report this rather than rerun/);
  });

  it('throws when the control task sits in another apply slot than the hippo-arm task', () => {
    const moved = RECORDS.map((r) => (r.arm === 'A1' && r.seed === 2 && r.position === 2 ? { ...r, applyIndex: 3 } : r));
    expect(() => costByKind(stub(), { arms: ['A1', 'A2'], scored: moved }, {})).toThrow(/A2\/A1 at seq seed 2 position 2: A2 has applyIndex 2 and A1 has 3, so a kind filter would read one arm only; the scored records cannot be cut by kind, so report this rather than rerun/);
  });
});

describe('Z0 cost by kind: parseArgs', () => {
  it('needs --analyzer and fills the defaults for the rest', () => {
    const args = parseArgs(['--analyzer', 'r3c']);
    expect(args).toMatchObject({ analyzer: 'r3c', report: 'C:/z0-runs/scored/r3-final/unblind.json', json: false, help: false });
    expect(args.grading.replaceAll('\\', '/')).toMatch(/\/docs\/evals\/z0-r3\/grading\.json$/);
    expect(args.dropList.replaceAll('\\', '/')).toMatch(/\/docs\/evals\/z0-r3\/drop-list\.json$/);
  });

  it('takes every flag', () => {
    expect(parseArgs(['--json', '--analyzer', 'a', '--report', 'r.json', '--grading', 'g.json', '--drop-list', 'd.json'])).toEqual({
      analyzer: 'a', report: 'r.json', grading: 'g.json', dropList: 'd.json', json: true, help: false,
    });
  });

  it('answers --help and -h without an analyzer', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('rejects a missing --analyzer, an unknown flag and a value flag with no value', () => {
    expect(() => parseArgs([])).toThrow(/--analyzer is required/);
    expect(() => parseArgs(['--json'])).toThrow(/--analyzer is required/);
    expect(() => parseArgs(['--analyzer', 'a', '--nope'])).toThrow(/unknown flag --nope\nusage:/);
    expect(() => parseArgs(['--analyzer'])).toThrow(/--analyzer needs a folder/);
    expect(() => parseArgs(['--analyzer', '--json'])).toThrow(/--analyzer needs a folder/);
    expect(() => parseArgs(['--analyzer', 'a', '--report'])).toThrow(/--report needs a file/);
  });
});

describe('Z0 cost by kind: formatText', () => {
  const row = (over: Partial<Cell> = {}): Cell => ({
    pair: 'A2/A1', seeds: 'all', kind: 'sets R+N', units: 995, ratio: 1.0057, low: 0.9639, high: 1.0493, p: 0.7908, se: 0.02, df: 248,
    dollarsT: 333, dollarsC: 331.1, dollarsDiff: 1.9, resolve: { estimate: 0.0049, low: -0.01, high: 0.02, p: 0.5 }, ...over,
  });
  const rep = (rows: Cell[], analyzer: Partial<Label> = {}) => ({
    analyzer: { root: 'r3c', sha: '04835462b', clean: true, node: 'v24.13.0', sources: 10, ...analyzer }, report: 'unblind.json',
    inputs: { runs: 35, plan: 35, matched: true },
    selfCheck: { exact: true, H3: EST, maintainerOnlyH3: EST, H4: { costRatio: EST, resolveDiff: { ...EST, estimate: -0.0004 } } },
    exploratory: { cells: rows.length, note: 'p not adjusted' }, rows,
  });

  it('prints the header block and a fixed-width row with set decimals', () => {
    const lines = formatText(rep([row()])).split('\n');
    expect(lines.slice(0, 5)).toEqual([
      'analyzer 04835462b clean, 10 sources match the report, node v24.13.0',
      'inputs 35 runs, 35 plans, prices, grading and drop list match the report',
      'self-check H3 1.006 [0.964, 1.049] and maintainer-only H3 1.006 [0.964, 1.049]: exact',
      'self-check H4 cost ratio 1.006 [0.964, 1.049] and resolve difference 0.000: exact',
      'exploratory 1 cells, p not adjusted',
    ]);
    expect(lines[6]).toMatch(/^A2\/A1 {3}all {4}sets R\+N {7}995 {3}1\.006 {3}0\.964 {3}1\.049 {3}0\.791 {5}333\.00 {5}331\.10 {6}\+1\.90 {3}\+0\.005$/);
  });

  it('prints n/a for a NaN or null cell and keeps the sign of a difference', () => {
    const text = formatText(rep([row({ ratio: Number.NaN, low: null, p: undefined, dollarsDiff: -8.123, resolve: { estimate: null, low: null, high: null, p: null } })]));
    const cells = text.split('\n')[6]!.trim().split(/\s{2,}/);
    expect(cells).toContain('n/a');
    expect(text).toContain('-8.12');
    expect(text.split('\n')[6]!.match(/n\/a/g)).toHaveLength(4);
  });

  const cellsOf = (...rows: Cell[]): string[][] => formatText(rep(rows)).split('\n').slice(6, 6 + rows.length).map((l) => l.trim().split(/\s{2,}/));

  it('prints a p under 0.0005 as <0.001 and any other p to three decimals', () => {
    const cells = cellsOf(row({ p: 0 }), row({ p: 0.00049 }), row({ p: 0.0006 }), row({ p: 0.7908 }));
    expect(cells.map((c) => c[7])).toEqual(['<0.001', '<0.001', '0.001', '0.791']);
  });

  it('prints a ratio or bound that rounds to 1.000 without being 1 with four digits, on the side of 1 it falls', () => {
    const [near, exact, plain] = cellsOf(
      row({ ratio: 1.00047, low: 0.99951, high: 1.0004 }), row({ ratio: 1, low: 1, high: 1 }), row({ ratio: 1.0006, low: 0.9994, high: 1.05 }),
    );
    expect(near!.slice(4, 7)).toEqual(['1.0005', '0.9995', '1.0004']);
    expect(exact!.slice(4, 7)).toEqual(['1.000', '1.000', '1.000']);
    expect(plain!.slice(4, 7)).toEqual(['1.001', '0.999', '1.050']);
  });

  it('keeps every row as wide as the header when a four-digit bound or a <0.001 p is printed', () => {
    const lines = formatText(rep([row({ ratio: 1.00047, low: 0.99951, high: 1.0004, p: 0.0001 }), row()])).split('\n');
    expect(lines[6]).toHaveLength(lines[5]!.length);
    expect(lines[7]).toHaveLength(lines[5]!.length);
    expect(lines[6]).toMatch(/995 {2}1\.0005 {2}0\.9995 {2}1\.0004 {2}<0\.001 /);
  });

  it('prints the header lines of the self-check with the same four-digit rule', () => {
    const near = { ...EST, estimate: 1.00047, low: 0.99951 };
    const text = formatText({ ...rep([]), selfCheck: { exact: true, H3: near, maintainerOnlyH3: EST, H4: { costRatio: EST, resolveDiff: EST } } });
    expect(text.split('\n')[2]).toContain('self-check H3 1.0005 [0.9995, 1.049]');
  });

  it('prints a value that rounds to zero without a sign, and keeps the sign of any other difference', () => {
    const zero = row({ dollarsDiff: -0.004, resolve: { estimate: 0.0004, low: null, high: null, p: null } });
    const small = row({ dollarsDiff: 0.006, resolve: { estimate: -0.0006, low: null, high: null, p: null } });
    const [a, b] = formatText(rep([zero, small])).split('\n').slice(6, 8).map((l) => l.trim().split(/\s{2,}/));
    expect(a!.slice(-2)).toEqual(['0.00', '0.000']);
    expect(b!.slice(-2)).toEqual(['+0.01', '-0.001']);
  });

  it('prints dirty for an edited tree and only the label for a folder without git', () => {
    expect(formatText(rep([], { clean: false })).split('\n')[0]).toContain('04835462b dirty,');
    expect(formatText(rep([], { sha: 'not a git checkout', clean: null })).split('\n')[0]).toContain('analyzer not a git checkout, 10 sources');
  });
});
