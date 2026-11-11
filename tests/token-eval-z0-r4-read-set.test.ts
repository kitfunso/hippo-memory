// Round 4 prereg item 9 and the Read set contract: one file of input pairs, so every read loads each folder's own off-pin file beside the runs file it names.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { DESIGNS } from '../scripts/token-eval/arms.mjs';
import { loadInputs } from '../scripts/token-eval/z0-analyze.mjs';
import { filteredInput } from '../scripts/token-eval/z0-filters.mjs';
import { runCli as leaks } from '../scripts/token-eval/z0-leaks.mjs';
import { runCli as merge } from '../scripts/token-eval/z0-merge.mjs';
import { readReadSet, runCli } from '../scripts/token-eval/z0-read-set.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';
import { generate, jsonl, planOf, type Z0Record } from './fixtures/z0-gen.js';

const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const json = <T>(file: string, value: T) => put(file, `${JSON.stringify(value)}\n`);
const offPinFor = (runsFile: string) => ({ schema: 'z0-offpin/1', runs: [{ dir: path.dirname(runsFile), file: path.basename(runsFile), sha256: sha(runsFile) }], voids: [] });
const forward = (p: string) => p.replace(/\\/g, '/');

/** A run folder `<dir>/run/` with its records, plan and the off-pin file beside it; returns the folder. */
function runFolder(dir: string, records: Z0Record[], leaks: { sequence: string; seed: number }[] | null) {
  put(path.join(dir, 'run', 'runs.jsonl'), `${jsonl(records)}\n`);
  json(path.join(dir, 'run', 'plan.json'), planOf(records));
  json(path.join(dir, 'off-pin.json'), offPinFor(path.join(dir, 'run', 'runs.jsonl')));
  if (leaks !== null) json(path.join(dir, 'leaks.json'), { schema: 'z0-leaks/1', runs: { file: 'x', sha256: 'x' }, leaks });
  return dir;
}

/** The merged folder z0-merge leaves for a key: the first run's records without the leaked seeds, and the manifest. */
function mergedFolder(root: string, name: string, records: Z0Record[]) {
  const merged = path.join(root, 'merged', 'batch1', name);
  put(path.join(merged, 'runs.jsonl'), `${jsonl(records)}\n`);
  json(path.join(merged, 'plan.json'), planOf(records));
  json(path.join(merged, 'off-pin.json'), offPinFor(path.join(merged, 'runs.jsonl')));
  json(path.join(merged, 'merge.json'), { schema: 'z0-merge/1' });
  return merged;
}

/** Keys k1 (a leak at seed 2, merged, and its rerun), k2 (its retry `-a2` completed, a leak at seed 3, merged, its rerun retried once) and k3 (batch 2, clean). */
function scene() {
  const root = tmp('z0-readset-');
  const R = forward(root);
  const g = generate({ design: DESIGNS.r4, repos: 3 });
  const of = (sequence: string, ...seeds: number[]) => g.records.filter((r) => r.sequence === sequence && seeds.includes(r.seed));
  json(path.join(root, 'pins-r4.json'), { batch1Keys: 'k1,k2', batch2Keys: 'k3' });
  const mark = (b: string, name: string, folder: string) => put(path.join(root, b, 'done', name), `${folder}\n`);
  // k1: the first run holds the leaked seed; the merged folder does not.
  runFolder(path.join(root, 'batch1', 'k1-w1'), of('rn-repo1', 1, 2, 3), [{ sequence: 'rn-repo1', seed: 2 }]);
  const merged = mergedFolder(root, 'k1-w1', of('rn-repo1', 1, 3));
  runFolder(path.join(root, 'batch1', 'k1-e2'), of('rn-repo1', 2), null);
  mark('batch1', 'k1', 'k1-w1');
  mark('batch1', 'k1-e2', 'k1-e2');
  // k2: its first attempt failed and left a folder the read must not touch.
  runFolder(path.join(root, 'batch1', 'k2-w1'), of('rn-repo2', 1), null);
  runFolder(path.join(root, 'batch1', 'k2-w1-a2'), of('rn-repo2', 1, 2, 3), [{ sequence: 'rn-repo2', seed: 3 }]);
  mergedFolder(root, 'k2-w1', of('rn-repo2', 1, 2));
  runFolder(path.join(root, 'batch1', 'k2-e3'), of('rn-repo2', 3).slice(0, 3), null);
  runFolder(path.join(root, 'batch1', 'k2-e3-a2'), of('rn-repo2', 3), null);
  mark('batch1', 'k2', 'k2-w1-a2');
  mark('batch1', 'k2-e3', 'k2-e3-a2');
  runFolder(path.join(root, 'batch2', 'k3-w1'), of('rn-repo3', 1, 2, 3), []);
  mark('batch2', 'k3', 'k3-w1');
  put(path.join(root, 'raise', 'NONE'), 'sha\n');
  const out = path.join(root, 'batch1', 'read-set.txt');
  const call = (batches: string) => runCli(['--root', root, '--batches', batches, '--out', out]);
  const lines = () => fs.readFileSync(out, 'utf8').split('\n');
  return { root, R, out, call, lines, merged };
}
const own = (R: string, name: string) => `--runs ${R}/${name}/run/runs.jsonl --plan ${R}/${name}/run/plan.json --off-pin ${R}/${name}/off-pin.json`;
const mergedLine = (R: string, name: string) => `--runs ${R}/merged/batch1/${name}/runs.jsonl --plan ${R}/merged/batch1/${name}/plan.json --off-pin ${R}/merged/batch1/${name}/off-pin.json --merge-manifest ${R}/merged/batch1/${name}/merge.json`;
const MISSING = 'STOP: merged/batch1/k1-w1 is missing or has no merge.json; run z0-merge\n';

describe('z0-read-set (Read set contract)', () => {
  afterEach(cleanup);

  it('names each leaked key\'s merged folder, a clean key\'s completed attempt and each leak rerun\'s completed attempt, in key order', () => {
    const s = scene();
    expect(s.call('1,2,raise')).toMatchObject({ code: 0 });
    expect(s.lines()).toEqual([
      mergedLine(s.R, 'k1-w1'),
      own(`${s.R}/batch1`, 'k1-e2'),
      mergedLine(s.R, 'k2-w1'),
      own(`${s.R}/batch1`, 'k2-e3-a2'),
      own(`${s.R}/batch2`, 'k3-w1'),
      '',
    ]);
  });

  it('reads batch 1 alone with `1`, and returns every pair through readReadSet, mergeManifest null when absent', () => {
    const s = scene();
    s.call('1');
    const set = readReadSet(s.out);
    expect(set.maxSeed).toBeNull();
    expect(set.pairs.map((p) => p.runs!.replace(`${s.R}/`, ''))).toEqual([
      'merged/batch1/k1-w1/runs.jsonl', 'batch1/k1-e2/run/runs.jsonl', 'merged/batch1/k2-w1/runs.jsonl', 'batch1/k2-e3-a2/run/runs.jsonl',
    ]);
    expect(set.pairs[0]).toMatchObject({ mergeManifest: `${s.R}/merged/batch1/k1-w1/merge.json` });
    expect(set.pairs[1]!.mergeManifest).toBeNull();
  });

  it('stops on a leaked key with no merged folder and on a merged folder with no merge.json, reading its first run whole in neither case', () => {
    const s = scene();
    fs.rmSync(s.merged, { recursive: true });
    expect(s.call('1')).toMatchObject({ code: 3, stderr: MISSING });
    put(path.join(s.merged, 'runs.jsonl'), '');
    expect(s.call('1')).toMatchObject({ code: 3, stderr: MISSING });
    put(path.join(s.merged, 'merge.json'), '{}\n');
    expect(s.call('1')).toMatchObject({ code: 0 });
  });

  it('names a wave that leaked whole by its merge manifest alone, and readReadSet returns it as a pair with no runs, plan or off-pin file', () => {
    const root = tmp('z0-readset-whole-');
    const R = forward(root);
    const g = generate({ design: DESIGNS.r4, repos: 1 });
    const records = g.records.filter((r) => r.seed === 1);
    Object.assign(records.find((r) => r.position === 4)!, { leak: true });
    json(path.join(root, 'pins-r4.json'), { batch1Keys: 'k1' });
    const first = runFolder(path.join(root, 'batch1', 'k1-w1'), records, null);
    expect(leaks(['--runs', `${first}/run/runs.jsonl`, '--plan', `${first}/run/plan.json`, '--out', `${first}/leaks.json`, '--design', 'r4'])).toMatchObject({ code: 0 });
    const rerun = runFolder(path.join(root, 'batch1', 'k1-e1'), records.map((r) => ({ ...r, leak: false })), null);
    const merged = path.join(root, 'merged', 'batch1', 'k1-w1');
    expect(merge(['--first', `${first}/run`, '--leaks', `${first}/leaks.json`, '--first-off-pin', `${first}/off-pin.json`, '--rerun-of', `${rerun}/run`, '--out', merged])).toMatchObject({ code: 0 });
    put(path.join(root, 'batch1', 'done', 'k1'), 'k1-w1\n');
    put(path.join(root, 'batch1', 'done', 'k1-e1'), 'k1-e1\n');
    const out = path.join(root, 'read-set.txt');
    expect(runCli(['--root', root, '--batches', '1', '--out', out])).toMatchObject({ code: 0, stdout: '2 lines\n' });
    expect(fs.readFileSync(out, 'utf8')).toBe(`--merge-manifest ${R}/merged/batch1/k1-w1/merge.json\n${own(`${R}/batch1`, 'k1-e1')}\n`);
    const { pairs } = readReadSet(out);
    expect(pairs[0]).toEqual({ runs: null, plan: null, offPin: null, mergeManifest: `${R}/merged/batch1/k1-w1/merge.json` });
    expect(pairs[1]).toMatchObject({ runs: `${R}/batch1/k1-e1/run/runs.jsonl`, mergeManifest: null });
  });

  it('loads through filteredInput with no readVoids error, and refuses the first run\'s off-pin file in a merged key\'s place', () => {
    const s = scene();
    s.call('1,2,raise');
    const { pairs } = readReadSet(s.out);
    const read = (list: { runs: string | null; plan: string | null; offPin: string | null }[]) => loadInputs({ runs: list.map((p) => p.runs!), plan: list.map((p) => p.plan!), offPin: list.map((p) => p.offPin!), prices: null, grading: null, dropList: null, out: null, design: 'r4' }, process.cwd());
    const inputs = read(pairs);
    expect(() => filteredInput(inputs.records, inputs.planCells, { voids: inputs.voids, design: inputs.design }, { dropAbandoned: false })).not.toThrow();
    const swapped = pairs.map((p, i) => (i === 0 ? { ...p, offPin: `${s.R}/batch1/k1-w1/off-pin.json` } : p));
    expect(() => read(swapped)).toThrow(/is not a runs file this read loads/);
  });

  it('writes the first line --max-seed from the sealed file, floored at 3, whatever the budget log holds, and none with no file', () => {
    const s = scene();
    put(path.join(s.root, 'budget-log.jsonl'), `${JSON.stringify({ kind: 'admit', maxSeed: 9 })}\n`);
    s.call('1,2,raise');
    expect(s.lines()[0]).not.toContain('--max-seed');
    json(path.join(s.root, 'raise', 'max-seed.json'), { maxSeed: 5, count: 7 });
    s.call('1,2,raise');
    expect(s.lines()[0]).toBe('--max-seed 5');
    expect(readReadSet(s.out).maxSeed).toBe(5);
    json(path.join(s.root, 'raise', 'max-seed.json'), { maxSeed: 2, count: 4 });
    s.call('1,2,raise');
    expect(s.lines()[0]).toBe('--max-seed 3');
    s.call('1,2');
    expect(s.lines()[0]).not.toContain('--max-seed');
  });

  it('reads every raise key at raise/<k>-w2, from the batch 1 keys and then the batch 2 keys', () => {
    const s = scene();
    fs.rmSync(path.join(s.root, 'raise', 'NONE'));
    const g = generate({ design: DESIGNS.r4, repos: 3 });
    for (const [k, seq] of [['k1', 'rn-repo1'], ['k2', 'rn-repo2'], ['k3', 'rn-repo3']] as const) {
      runFolder(path.join(s.root, 'raise', `${k}-w2`), g.records.filter((r) => r.sequence === seq && r.seed === 4), []);
      put(path.join(s.root, 'raise', 'done', k), `${k}-w2\n`);
    }
    s.call('1,2,raise');
    expect(s.lines().slice(-4)).toEqual(['k1', 'k2', 'k3'].map((k) => own(`${s.R}/raise`, `${k}-w2`)).concat(''));
  });

  it('stops on a missing raise folder without NONE, a missing done marker and a runs.regraded.jsonl, each naming the cause', () => {
    const s = scene();
    fs.rmSync(path.join(s.root, 'raise', 'NONE'));
    expect(s.call('1,2,raise')).toMatchObject({ code: 3, stderr: 'STOP: raise/k1-w2 is missing and raise/NONE is absent\n' });
    put(path.join(s.root, 'raise', 'NONE'), 'sha\n');
    fs.rmSync(path.join(s.root, 'batch1', 'done', 'k2-e3'));
    expect(s.call('1')).toMatchObject({ code: 3, stderr: expect.stringContaining('done/k2-e3') });
    put(path.join(s.root, 'batch1', 'done', 'k2-e3'), 'k2-e3-a2\n');
    fs.rmSync(path.join(s.root, 'batch2', 'done', 'k3'));
    expect(s.call('1,2')).toMatchObject({ code: 3, stderr: expect.stringMatching(/^STOP: .*done\/k3/) });
    put(path.join(s.root, 'batch2', 'done', 'k3'), 'k3-w1\n');
    put(path.join(s.root, 'batch2', 'k3-w1', 'run', 'runs.regraded.jsonl'), '');
    expect(s.call('1,2')).toMatchObject({ code: 3, stderr: expect.stringMatching(/^STOP: .*runs\.regraded\.jsonl/) });
  });

  it('refuses a --max-seed that is not an integer of 3 or more, an unknown flag and a line missing a flag, when readReadSet reads the file', () => {
    const s = scene();
    const lineOf = (text: string) => {
      put(path.join(s.root, 'line.txt'), `${text}\n`);
      return () => readReadSet(path.join(s.root, 'line.txt'));
    };
    for (const bad of ['--max-seed abc', '--max-seed 2', '--max-seed 3.5', '--max-seed 5 --runs a']) expect(lineOf(bad), bad).toThrow(/--max-seed line holds that flag alone/);
    expect(lineOf('--runs a --plan b --off-pin c --colour red')).toThrow(/unknown flag --colour/);
    expect(lineOf('--runs a --plan b')).toThrow(/a line needs --off-pin/);
    expect(lineOf('--max-seed 3')().maxSeed).toBe(3);
  });

  it('resolves a relative --root against its folder, so the lines hold absolute paths and match those of the absolute root', () => {
    const s = scene();
    s.call('1,2,raise');
    const absolute = fs.readFileSync(s.out, 'utf8');
    expect(runCli(['--root', path.basename(s.root), '--batches', '1,2,raise', '--out', s.out], path.dirname(s.root))).toMatchObject({ code: 0 });
    expect(fs.readFileSync(s.out, 'utf8')).toBe(absolute);
    expect(runCli(['--root', 'a b', '--batches', '1', '--out', s.out], path.dirname(s.root))).toMatchObject({ code: 1, stderr: expect.stringContaining('space') });
  });

  it('exits 1 on a bad batches list, a root with a space and a malformed marker, and writes the file again on a rerun', () => {
    const s = scene();
    expect(s.call('2')).toMatchObject({ code: 1, stderr: expect.stringContaining('usage:') });
    expect(runCli(['--root', 'C:/a b', '--batches', '1', '--out', s.out])).toMatchObject({ code: 1, stderr: expect.stringContaining('space') });
    put(path.join(s.root, 'batch1', 'done', 'k1'), 'k1-w1');
    expect(s.call('1')).toMatchObject({ code: 1, stderr: expect.stringContaining('done/k1') });
    put(path.join(s.root, 'batch1', 'done', 'k1'), 'k1-w1\n');
    expect(s.call('1')).toMatchObject({ code: 0 });
    const first = fs.readFileSync(s.out, 'utf8');
    expect(s.call('1')).toMatchObject({ code: 0 });
    expect(fs.readFileSync(s.out, 'utf8')).toBe(first);
  });
});
