/** Z0 cost by kind end to end over a stub analyzer tree and a stub report: the hash gates, the self-check, the agreement and partition stops, and the print. */
import { describe, it, expect, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../scripts/token-eval/z0-cost-by-kind.mjs';

interface Rec { arm: string; sequence: string; seed: number; position: number; set: string; kind: string; applyIndex: number | null; cost: number; lessonSource: string }
interface Est { estimate: number; low: number; high: number; se: number; df: number; p: number }
interface StubReport {
  hashes: { role: string; file: string; sha256: string }[];
  hypotheses: { H3: Est & { bootstrap: { low: number } }; H4: { costRatio: Est; resolveDiff: Est } };
  reported: { maintainerOnly: { H3: Est } };
}
interface Tree { base: string; analyzer: string; report: string; grading: string; dropList: string; seen: string; flags: string[] }

const SCRIPT = fileURLToPath(new URL('../../scripts/token-eval/z0-cost-by-kind.mjs', import.meta.url));
const COSTS = { A1: 1, A2: 2, A5: 1.5 } as const;
type Arm = keyof typeof COSTS;
const SOURCES = [
  'scripts/token-eval/z0-records.mjs', 'scripts/token-eval/z0-filters.mjs', 'scripts/token-eval/z0-hypotheses.mjs', 'scripts/token-eval/z0-gates.mjs',
  'scripts/token-eval/z0-blind.mjs', 'scripts/token-eval/z0-analyze.mjs', 'src/eval/eval-stats.ts', 'dist/eval/eval-stats.js', 'src/eval/repository-t.ts', 'dist/eval/repository-t.js',
];

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
// The stub's ratioT and harmT return a pure function of the unit count, so the test pins counts, not a statistic.
const est = (n: number) => ({ estimate: n / 10, low: n / 20, high: n / 5, se: 0.5, df: 7, p: 0.25 });
const RESOLVE = { ...est(0), estimate: 0.125 };

/** Three seeds of four positions per arm: a teach, two R applies (the second from a template) and one set N task. */
function records(arms: Arm[]): Rec[] {
  const slots = [['R', 'teach', null], ['R', 'apply', 1], ['R', 'apply', 2], ['N', 'apply', null]] as const;
  return arms.flatMap((arm) => [1, 2, 3].flatMap((seed) => slots.map(([set, kind, applyIndex], position) => ({
    arm, sequence: 'seq', seed, position, set, kind, applyIndex, cost: COSTS[arm], lessonSource: position === 2 ? 'template' : 'maintainer',
  }))));
}

const ANALYZE = `import * as fs from 'node:fs';
export const loadInputs = (args, cwd) => {
  fs.writeFileSync(new URL('../../seen.json', import.meta.url), JSON.stringify({ args, cwd }));
  return { records: [], planCells: [], prices: { 'claude-code': { rate: 1 } }, grading: null, dropList: null };
};
`;
const filters = (scored: Rec[]) => `export const filterRecords = () => ({ arms: ${JSON.stringify([...new Set(scored.map((r) => r.arm))].sort())}, scored: ${JSON.stringify(scored)} });
export const pairTasks = (scored, armT, armC) => scored.filter((t) => t.arm === armT)
  .map((t) => ({ t, c: scored.find((c) => c.arm === armC && c.seed === t.seed && c.position === t.position) }))
  .filter((pair) => pair.c !== undefined);
`;
const HYPOTHESES = `import { pairTasks } from './z0-filters.mjs';
const est = (n) => ({ estimate: n / 10, low: n / 20, high: n / 5, se: 0.5, df: 7, p: 0.25 });
export const inSets = (...sets) => (r) => sets.includes(r.set);
export const maintainer = (r) => r.lessonSource !== 'template';
export const taskUnits = (scored, armT, armC, prices, keep) => pairTasks(scored, armT, armC)
  .filter(({ t }) => keep(t)).map(({ t, c }) => ({ t: { cost: t.cost }, c: { cost: c.cost } }));
export const ratioT = (units) => est(units.length);
export const harmT = (units) => ({ costRatio: est(units.length), resolveDiff: { ...est(0), estimate: 0.125 } });
`;

describe('Z0 cost by kind CLI', () => {
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
  const write = (file: string, text: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  /** One tree per case: Node caches a module by URL, so a stub that changes needs a new folder. */
  function build(over: { scored?: Rec[]; report?: (r: StubReport) => void } = {}): Tree {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-kind-cli-'));
    dirs.push(base);
    const analyzer = path.join(base, 'analyzer');
    const text: Record<string, string> = Object.fromEntries(SOURCES.map((s) => [s, `// stub ${s}\n`]));
    text['scripts/token-eval/z0-analyze.mjs'] = ANALYZE;
    text['scripts/token-eval/z0-filters.mjs'] = filters(over.scored ?? records(['A1', 'A2', 'A5']));
    text['scripts/token-eval/z0-hypotheses.mjs'] = HYPOTHESES;
    for (const [file, body] of Object.entries(text)) write(path.join(analyzer, file), body);
    const inputs = { 'a.jsonl': 'run a', 'b.jsonl': 'run b', 'p1.json': 'plan 1', 'p2.json': 'plan 2', 'prices.json': '{}', 'grading.json': '{"g":1}', 'drop.json': '{"d":1}' };
    for (const [file, body] of Object.entries(inputs)) write(path.join(base, 'in', file), body);
    const at = (file: string) => path.join(base, 'in', file).replaceAll('\\', '/');
    const entry = (role: string, file: string, body: string) => ({ role, file, sha256: sha(body) });
    const report: StubReport = {
      hashes: [
        entry('prices', at('prices.json'), inputs['prices.json']),
        entry('grading', 'C:/deleted-worktree/grading.json', inputs['grading.json']),
        entry('drop-list', 'C:/deleted-worktree/drop-list.json', inputs['drop.json']),
        ...SOURCES.map((s) => entry('source', s, text[s]!)),
        entry('runs', at('b.jsonl'), inputs['b.jsonl']), entry('runs', at('a.jsonl'), inputs['a.jsonl']),
        entry('plan', at('p2.json'), inputs['p2.json']), entry('plan', at('p1.json'), inputs['p1.json']),
      ],
      hypotheses: { H3: { ...est(12), bootstrap: { low: 99 } }, H4: { costRatio: est(3), resolveDiff: { ...RESOLVE } } },
      reported: { maintainerOnly: { H3: est(9) } },
    };
    over.report?.(report);
    const [reportFile, grading, dropList] = [path.join(base, 'unblind.json'), path.join(base, 'in', 'grading.json'), path.join(base, 'in', 'drop.json')];
    write(reportFile, JSON.stringify(report));
    const flags = ['--analyzer', analyzer, '--report', reportFile, '--grading', grading, '--drop-list', dropList];
    return { base, analyzer, report: reportFile, grading, dropList, seen: path.join(analyzer, 'seen.json'), flags };
  }

  it('reads every cell from the stub analyzer, with the hash gates passed and the report paths for grading and drop list never read', async () => {
    const t = build();
    const out = await runCli([...t.flags, '--json']);
    expect(out).toMatchObject({ code: 0, stderr: '' });
    const rep = JSON.parse(out.stdout);
    expect(rep.analyzer).toMatchObject({ root: t.analyzer, sha: 'not a git checkout', clean: null, node: process.version, sources: 10 });
    expect(rep.inputs).toEqual({ runs: 2, plan: 2, matched: true });
    expect(rep.selfCheck).toMatchObject({ exact: true, H3: est(12), maintainerOnlyH3: est(9), H4: { costRatio: est(3), resolveDiff: RESOLVE } });
    expect(rep.exploratory).toEqual({ cells: 25, note: 'p not adjusted' });
    expect(rep.rows.map((r: { pair: string; seeds: string }) => `${r.pair} ${r.seeds}`).filter((_: string, i: number) => i % 5 === 0))
      .toEqual(['A2/A1 all', 'A5/A1 all', 'A2/A5 all', 'A2/A1 s1-2', 'A5/A1 s1-2']);
    const whole = rep.rows.find((r: { pair: string; seeds: string; kind: string }) => r.pair === 'A2/A1' && r.seeds === 'all' && r.kind === 'sets R+N');
    expect(whole).toMatchObject({ units: 12, ratio: 1.2, dollarsT: 24, dollarsC: 12, dollarsDiff: 12, resolve: { estimate: 0.125 } });
    const early = rep.rows.find((r: { pair: string; seeds: string; kind: string }) => r.pair === 'A5/A1' && r.seeds === 's1-2' && r.kind === 'first apply');
    expect(early).toMatchObject({ units: 2, dollarsT: 3, dollarsC: 2, dollarsDiff: 1 });
    const seen = JSON.parse(fs.readFileSync(t.seen, 'utf8'));
    expect(seen.args).toEqual({
      runs: [path.join(t.base, 'in', 'b.jsonl').replaceAll('\\', '/'), path.join(t.base, 'in', 'a.jsonl').replaceAll('\\', '/')],
      plan: [path.join(t.base, 'in', 'p2.json').replaceAll('\\', '/'), path.join(t.base, 'in', 'p1.json').replaceAll('\\', '/')],
      prices: path.join(t.base, 'in', 'prices.json').replaceAll('\\', '/'), grading: t.grading, dropList: t.dropList,
      key: null, out: null, seed: null, iterations: null, unblind: false, help: false,
    });
  });

  it('prints the header block and one fixed-width line per cell', async () => {
    const t = build();
    const out = await runCli(t.flags);
    const lines = out.stdout.split('\n');
    expect(lines[0]).toBe(`analyzer not a git checkout, 10 sources match the report, node ${process.version}`);
    expect(lines[1]).toBe('inputs 2 runs, 2 plans, prices, grading and drop list match the report');
    expect(lines[2]).toBe('self-check H3 1.200 [0.600, 2.400] and maintainer-only H3 0.900 [0.450, 1.800]: exact');
    expect(lines[3]).toBe('self-check H4 cost ratio 0.300 [0.150, 0.600] and resolve difference +0.125: exact');
    expect(lines[4]).toBe('exploratory 25 cells, p not adjusted');
    expect(lines).toHaveLength(5 + 1 + 25 + 1);
    expect(lines[6]).toMatch(/^A2\/A1 {3}all {4}sets R\+N {8}12 {3}1\.200 {3}0\.600 {3}2\.400 {3}0\.250 {6}24\.00 {6}12\.00 {5}\+12\.00 {3}\+0\.125$/);
  });

  it('stops on a changed source file, naming it, both hashes and the fix', async () => {
    const t = build();
    fs.appendFileSync(path.join(t.analyzer, 'dist/eval/repository-t.js'), 'x');
    const out = await runCli(t.flags);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toMatch(/^z0-cost-by-kind: dist\/eval\/repository-t\.js under --analyzer .* has sha256 [0-9a-f]{64}, the report recorded [0-9a-f]{64}; check out 04835462b at --analyzer, then run npm ci and npm run build there\n$/);
  });

  it('stops on a missing source file', async () => {
    const t = build();
    fs.rmSync(path.join(t.analyzer, 'src/eval/eval-stats.ts'));
    expect(await runCli(t.flags)).toMatchObject({ code: 1, stderr: expect.stringContaining('src/eval/eval-stats.ts is missing under --analyzer') });
  });

  it('stops on a changed runs file, naming it, and on a changed --grading file', async () => {
    const t = build();
    fs.appendFileSync(path.join(t.base, 'in', 'a.jsonl'), '\n');
    const runs = await runCli(t.flags);
    expect(runs.code).toBe(1);
    expect(runs.stderr).toMatch(/runs file .*a\.jsonl has sha256 [0-9a-f]{64}, the report recorded [0-9a-f]{64}/);
    const g = build();
    fs.writeFileSync(g.grading, '{"g":2}');
    expect(await runCli(g.flags)).toMatchObject({ code: 1, stderr: expect.stringMatching(/z0-cost-by-kind: --grading .*grading\.json has sha256 .*pass the grading file round 3 read/) });
  });

  it('stops when the analyzer does not give the H3 line round 3 reported, naming the field and the node version', async () => {
    const t = build({ report: (r) => { r.hypotheses.H3.low += 2 ** -50; } });
    const out = await runCli(t.flags);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('z0-cost-by-kind: self-check H3 differs from the report in low');
    expect(out.stderr).toMatch(/ {2}low: got 0\.6, want 0\.6000000000000\d+/);
    expect(out.stderr).toContain(`node ${process.version}`);
  });

  it('stops on a maintainer-only H3 miss and on an H4 resolve miss', async () => {
    const m = build({ report: (r) => { r.reported.maintainerOnly.H3.p = 0.3; } });
    expect((await runCli(m.flags)).stderr).toContain('self-check maintainer-only H3 differs from the report in p');
    const h = build({ report: (r) => { r.hypotheses.H4.resolveDiff.estimate = 0.5; } });
    expect((await runCli(h.flags)).stderr).toContain('self-check H4 resolve difference differs from the report in estimate');
  });

  it('stops when the hippo-arm and control tasks differ in set, kind or apply slot', async () => {
    const scored = records(['A1', 'A2', 'A5']).map((r) => (r.arm === 'A1' && r.seed === 2 && r.position === 1 ? { ...r, applyIndex: 2 } : r));
    const out = await runCli(build({ scored }).flags);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('z0-cost-by-kind: A2/A1 at seq seed 2 position 1: A2 has applyIndex 1 and A1 has 2');
  });

  it('stops when the four kinds do not add up to sets R and N', async () => {
    const scored = records(['A1', 'A2', 'A5']).map((r) => (r.seed === 1 && r.position === 0 ? { ...r, kind: 'warmup' } : r));
    const out = await runCli(build({ scored }).flags);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('z0-cost-by-kind: A2/A1 all: the four kinds hold 11 units and sets R+N holds 12');
  });

  it('skips a pair with an arm the plan left out', async () => {
    const t = build({ scored: records(['A1', 'A2']) });
    const rep = JSON.parse((await runCli([...t.flags, '--json'])).stdout);
    expect(rep.exploratory.cells).toBe(10);
  });

  it('reads a relative --analyzer from the working folder', async () => {
    const t = build();
    const prev = process.cwd();
    process.chdir(t.base);
    try {
      const out = await runCli(['--analyzer', 'analyzer', ...t.flags.slice(2), '--json']);
      expect(out.code).toBe(0);
      expect(fs.realpathSync(JSON.parse(out.stdout).analyzer.root)).toBe(fs.realpathSync(t.analyzer));
      expect(fs.realpathSync(JSON.parse(fs.readFileSync(t.seen, 'utf8')).cwd)).toBe(fs.realpathSync(t.base));
    } finally {
      process.chdir(prev);
    }
  });

  it('stops on a missing analyzer folder, a missing report and a report with no hashes', async () => {
    const t = build();
    expect(await runCli([...t.flags.slice(2), '--analyzer', path.join(t.base, 'nope')])).toMatchObject({ code: 1, stderr: expect.stringContaining('no folder at --analyzer') });
    expect(await runCli([...t.flags.slice(0, 2), '--report', path.join(t.base, 'nope.json')])).toMatchObject({ code: 1, stderr: expect.stringContaining('cannot read --report') });
    fs.writeFileSync(t.report, '{}');
    expect(await runCli(t.flags)).toMatchObject({ code: 1, stderr: expect.stringContaining('has no hashes list') });
  });

  it('runs as a command: usage on --help, exit 1 and a prefixed error without --analyzer', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^usage: z0-cost-by-kind\.mjs --analyzer DIR/);
    const bare = run();
    expect(bare.status).toBe(1);
    expect(bare.stderr).toMatch(/^z0-cost-by-kind: --analyzer is required/);
  });
});
