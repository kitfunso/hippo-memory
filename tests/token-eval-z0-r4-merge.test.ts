// Round 4 prereg item 9 (Amendment E as a standing rule): z0-merge drops each leaked (sequence, seed) from the first run and keeps the reruns apart, joined at the read.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { computeGates } from '../scripts/token-eval/z0-gates.mjs';
import { loadInputs } from '../scripts/token-eval/z0-analyze.mjs';
import { filteredInput } from '../scripts/token-eval/z0-filters.mjs';
import { runCli as leaks } from '../scripts/token-eval/z0-leaks.mjs';
import { readMergeManifest, runCli as merge } from '../scripts/token-eval/z0-merge.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';
import { generate, jsonl, planOf, type PlanCell, type Z0Record } from './fixtures/z0-gen.js';

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SEQ = 'rn-repo1';
const VOID = { sequence: SEQ, arm: 'S2', sessionId: 'sess', reason: 'effort high, pinned medium' };

function writeOut(dir: string, records: Z0Record[], plan: PlanCell[]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runs.jsonl'), `${jsonl(records)}\n`);
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  return dir;
}

/** A first run of three seeds with a leak at seed 2, a rerun of seed 2, and a first-run off-pin file with a void at seed 1 and one at seed 2. */
function scene(opts: { rerunLeaks?: boolean; rerunSeeds?: number[]; firstSeeds?: number[] } = {}) {
  const root = tmp('z0-merge-');
  const g = generate({ design: DESIGNS.r4, repos: 1 });
  const hit = g.records.find((r) => r.seed === 2 && r.position === 4)!;
  Object.assign(hit, { leak: true });
  const inFirst = (x: { seed: number }) => (opts.firstSeeds ?? [1, 2, 3]).includes(x.seed);
  const first = writeOut(path.join(root, 'first'), g.records.filter(inFirst), g.plan.filter(inFirst));
  const seeds = opts.rerunSeeds ?? [2];
  const rerunRecords = g.records.filter((r) => seeds.includes(r.seed)).map((r) => ({ ...r, sessionId: `rerun-${r.position}`, leak: opts.rerunLeaks === true && r.seed === 2 && r.position === 4 && r.arm === hit.arm }));
  const rerun = writeOut(path.join(root, 'rerun'), rerunRecords, planOf(rerunRecords));
  const listed = path.join(root, 'leaks.json');
  expect(leaks(['--runs', path.join(first, 'runs.jsonl'), '--plan', path.join(first, 'plan.json'), '--out', listed, '--design', 'r4'])).toMatchObject({ code: 0 });
  const offPin = path.join(root, 'first-off-pin.json');
  const bound = (runsFile: string) => ({ dir: path.dirname(runsFile), file: path.basename(runsFile), sha256: sha(runsFile) });
  const writeOffPin = (runsFile: string) => fs.writeFileSync(offPin, JSON.stringify({ schema: 'z0-offpin/1', runs: [bound(runsFile)], voids: [{ ...VOID, seed: 1, position: 7 }, { ...VOID, seed: 2, position: 9 }] }));
  writeOffPin(path.join(first, 'runs.jsonl'));
  const out = path.join(root, 'merged');
  const argv = ['--first', first, '--leaks', listed, '--first-off-pin', offPin, '--rerun-of', rerun, '--out', out];
  return { root, first, rerun, listed, offPin, out, argv, records: g.records, plan: g.plan, writeOffPin };
}
const parsed = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const load = (runs: string, plan: string, offPin?: string) => loadInputs({ runs: [runs], plan: [plan], offPin: offPin === undefined ? [] : [offPin], prices: null, grading: null, dropList: null, out: null, design: 'r4' }, process.cwd());

describe('z0-merge on a synthetic round 4 first run (prereg item 9)', () => {
  afterEach(cleanup);

  it('drops every record and plan cell of the leaked seed, keeping the other lines byte for byte and in order', () => {
    const s = scene();
    expect(merge(s.argv)).toMatchObject({ code: 0 });
    const lines = fs.readFileSync(path.join(s.first, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean);
    const kept = fs.readFileSync(path.join(s.out, 'runs.jsonl'), 'utf8');
    expect(kept).toBe(lines.filter((l) => JSON.parse(l).seed !== 2).map((l) => `${l}\n`).join(''));
    expect(JSON.parse(fs.readFileSync(path.join(s.out, 'plan.json'), 'utf8'))).toEqual(s.plan.filter((c) => c.seed !== 2));
  });

  it('keeps the void at a kept seed, drops the one at the leaked seed, names the merged runs file and loads against it only', () => {
    const s = scene();
    merge(s.argv);
    const file = JSON.parse(fs.readFileSync(path.join(s.out, 'off-pin.json'), 'utf8'));
    expect(file.voids).toEqual([{ ...VOID, seed: 1, position: 7 }]);
    expect(file.runs).toEqual([{ dir: expect.any(String), file: 'runs.jsonl', sha256: sha(path.join(s.out, 'runs.jsonl')) }]);
    expect(load(path.join(s.out, 'runs.jsonl'), path.join(s.out, 'plan.json'), path.join(s.out, 'off-pin.json')).voids).toHaveLength(1);
    expect(() => load(path.join(s.first, 'runs.jsonl'), path.join(s.first, 'plan.json'), path.join(s.out, 'off-pin.json'))).toThrow(/is not a runs file this read loads/);
  });

  it('writes merge.json with the hashes, the dropped seeds and the first run\'s counts, and readMergeManifest returns it', () => {
    const s = scene();
    merge(s.argv);
    const manifest = readMergeManifest(path.join(s.out, 'merge.json'));
    expect(manifest).toMatchObject({
      schema: 'z0-merge/1',
      first: { file: 'runs.jsonl', sha256: sha(path.join(s.first, 'runs.jsonl')) },
      droppedSeeds: { [SEQ]: [2] },
      firstRun: { plannedSequenceSeeds: 3, leakedSequenceSeeds: 1 },
    });
    expect(manifest.hashes).toEqual([{ role: 'leaks', file: expect.any(String), sha256: sha(s.listed) }, { role: 'first-off-pin', file: expect.any(String), sha256: sha(s.offPin) }]);
    fs.writeFileSync(path.join(s.root, 'bad.json'), JSON.stringify({ schema: 'z0-merge/9' }));
    expect(() => readMergeManifest(path.join(s.root, 'bad.json'))).toThrow(/schema/);
  });

  it('writes merge.json alone, with its counts, when every seed of the first run leaked, since parsePlan refuses an empty plan', () => {
    const s = scene({ firstSeeds: [2] });
    expect(merge(s.argv)).toMatchObject({ code: 0, stdout: 'merged 0 records, dropped 1 leaked seeds, 0 voids kept\n' });
    expect(fs.readdirSync(s.out)).toEqual(['merge.json']);
    expect(readMergeManifest(path.join(s.out, 'merge.json'))).toMatchObject({ droppedSeeds: { [SEQ]: [2] }, firstRun: { plannedSequenceSeeds: 1, leakedSequenceSeeds: 1 } });
    expect(merge(s.argv)).toMatchObject({ code: 0 });
  });

  it('removes the runs, plan and off-pin files an earlier merge left in --out when every seed leaked, so the read set cannot read them beside the manifest', () => {
    const earlier = scene();
    expect(merge(earlier.argv)).toMatchObject({ code: 0 });
    expect(fs.readdirSync(earlier.out).sort()).toEqual(['merge.json', 'off-pin.json', 'plan.json', 'runs.jsonl']);
    const whole = scene({ firstSeeds: [2] });
    expect(merge([...whole.argv.slice(0, -1), earlier.out])).toMatchObject({ code: 0 });
    expect(fs.readdirSync(earlier.out)).toEqual(['merge.json']);
    expect(readMergeManifest(path.join(earlier.out, 'merge.json'))).toMatchObject({ first: { sha256: sha(path.join(whole.first, 'runs.jsonl')) }, firstRun: { plannedSequenceSeeds: 1, leakedSequenceSeeds: 1 } });
  });

  it('removes merge.json before it writes anything, so a cut-off partial merge never leaves an old manifest beside new files', () => {
    const earlier = scene({ firstSeeds: [2] });
    expect(merge(earlier.argv)).toMatchObject({ code: 0 });
    expect(fs.readdirSync(earlier.out)).toEqual(['merge.json']);
    // A directory where off-pin.json belongs fails the third write, after runs.jsonl and plan.json are in place.
    fs.mkdirSync(path.join(earlier.out, 'off-pin.json'));
    const partial = scene();
    expect(merge([...partial.argv.slice(0, -1), earlier.out])).toMatchObject({ code: 1 });
    expect(fs.existsSync(path.join(earlier.out, 'merge.json'))).toBe(false);
    expect(fs.existsSync(path.join(earlier.out, 'runs.jsonl'))).toBe(true);
  });

  it('refuses a rerun folder that holds another seed, a leak with no rerun, a stray rerun and a leak list for another runs file', () => {
    const wrong = scene({ rerunSeeds: [2, 3] });
    expect(merge(wrong.argv)).toMatchObject({ code: 1, stderr: expect.stringContaining('holds seeds other than 2') });
    const s = scene();
    const noRerun = s.argv.filter((_, i) => i !== 6 && i !== 7);
    expect(merge(noRerun)).toMatchObject({ code: 1, stderr: expect.stringContaining(`${SEQ} seed 2 has no --rerun-of folder`) });
    const stray = scene();
    const strayDir = writeOut(path.join(stray.root, 'stray'), stray.records.filter((r) => r.seed === 3), stray.plan.filter((c) => c.seed === 3));
    expect(merge([...stray.argv, '--rerun-of', strayDir])).toMatchObject({ code: 1, stderr: expect.stringContaining('is not a rerun of a leaked seed') });
    const other = scene();
    fs.appendFileSync(path.join(other.first, 'runs.jsonl'), `${JSON.stringify(other.records[0])}\n`);
    expect(merge(other.argv)).toMatchObject({ code: 1, stderr: expect.stringContaining('was written for another runs file') });
  });

  it('refuses a first off-pin file written for another runs file', () => {
    const s = scene();
    s.writeOffPin(path.join(s.rerun, 'runs.jsonl'));
    expect(merge(s.argv)).toMatchObject({ code: 1, stderr: expect.stringContaining('is not a runs file this read loads') });
  });

  it('stops on a runs.regraded.jsonl beside the first run, naming it, and reads --first-runs when given', () => {
    const s = scene();
    const regraded = path.join(s.first, 'runs.regraded.jsonl');
    const [head, ...rest] = fs.readFileSync(path.join(s.first, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(regraded, `${[JSON.stringify({ ...JSON.parse(head!), regraded: true }), ...rest].join('\n')}\n`);
    const stop = merge(s.argv);
    expect(stop).toMatchObject({ code: 3, stderr: expect.stringContaining('STOP:') });
    expect(stop.stderr).toContain('runs.regraded.jsonl');
    // The leak list and the off-pin file are bound to the file the merge reads, so both are written for it.
    expect(leaks(['--runs', regraded, '--plan', path.join(s.first, 'plan.json'), '--out', s.listed, '--design', 'r4'])).toMatchObject({ code: 0 });
    s.writeOffPin(regraded);
    expect(merge([...s.argv, '--first-runs', regraded])).toMatchObject({ code: 0 });
    expect(readMergeManifest(path.join(s.out, 'merge.json')).first.sha256).toBe(sha(regraded));
    expect(parsed(path.join(s.out, 'runs.jsonl'))[0]).toMatchObject({ regraded: true });
  });

  it('exits 1 with its usage on a missing flag, and rewrites its files when run again', () => {
    const s = scene();
    expect(merge(['--first', s.first])).toMatchObject({ code: 1, stderr: expect.stringContaining('usage:') });
    expect(merge(s.argv)).toMatchObject({ code: 0 });
    const before = fs.readFileSync(path.join(s.out, 'merge.json'), 'utf8');
    expect(merge(s.argv)).toMatchObject({ code: 0 });
    expect(fs.readFileSync(path.join(s.out, 'merge.json'), 'utf8')).toBe(before);
  });
});

describe('a seed that leaks in its first run and in its rerun stays leaked (prereg item 9)', () => {
  afterEach(cleanup);

  it('is dropped from the first run, stays a leak in the rerun, and G3 counts it once after reruns and once in the first-run count', () => {
    const s = scene({ rerunLeaks: true });
    expect(merge(s.argv)).toMatchObject({ code: 0 });
    const runs = [path.join(s.out, 'runs.jsonl'), path.join(s.rerun, 'runs.jsonl')];
    const plans = [path.join(s.out, 'plan.json'), path.join(s.rerun, 'plan.json')];
    const inputs = loadInputs({ runs, plan: plans, offPin: [], prices: null, grading: null, dropList: null, out: null, design: 'r4' }, process.cwd());
    expect(parsed(runs[0]!).some((r) => r.seed === 2)).toBe(false);
    expect(parsed(runs[1]!).filter((r) => r.leak === true)).toHaveLength(1);
    const { filtered, records } = filteredInput(inputs.records, inputs.planCells, { design: inputs.design }, { dropAbandoned: false });
    expect(filtered.leaked).toEqual([`${SEQ} seed 2`]);
    const gates = computeGates(records, filtered, null, { iterations: 50, seed: 1, design: DESIGNS.r4, mergeManifests: [readMergeManifest(path.join(s.out, 'merge.json'))] });
    expect(gates.G3).toMatchObject({ leaked: 1, plannedRuns: 3, firstRun: { leakedSequenceSeeds: 1, plannedRuns: 3 } });
  });
});
