// Round 4 prereg item 11: an input hash covers every input and every source the entry loads, and a folder hashes as a tree.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { inputHashes, sourceRows } from '../scripts/token-eval/z0-blind.mjs';
import { treeHash } from '../scripts/token-eval/pins.mjs';

const REPO = path.resolve(__dirname, '..');
const ENTRY = 'scripts/token-eval/z0-analyze.mjs';
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'z0-r4-hashes-'));
const files = (rows: { file: string }[]) => rows.map((r) => r.file);

describe('sourceRows', () => {
  it('lists, repo-relative, every file the entry loads: arms.mjs, exec.mjs and the dist files', () => {
    const rows = sourceRows(ENTRY);
    expect(files(rows)).toEqual(expect.arrayContaining([ENTRY, 'scripts/token-eval/arms.mjs', 'scripts/token-eval/exec.mjs', 'scripts/token-eval/z0-prices.mjs', 'scripts/token-eval/pins.mjs', 'dist/eval/eval-stats.js']));
    for (const r of rows) expect([r.role, r.sha256], r.file).toEqual(['source', sha(path.join(REPO, r.file))]);
  });

  it('gives z0-seed-rule.mjs z0-size.mjs and z0-size-sim.mjs once each', () => {
    const names = files(sourceRows('scripts/token-eval/z0-seed-rule.mjs'));
    expect(names).toEqual(expect.arrayContaining(['scripts/token-eval/z0-size.mjs', 'scripts/token-eval/z0-size-sim.mjs', 'scripts/token-eval/z0-analyze.mjs']));
    expect(new Set(names).size).toBe(names.length);
  });

  // One scratch copy per entry: an import added to one entry would otherwise reach the entries that load it.
  const scratch = () => {
    const root = tmp();
    for (const dir of ['scripts/token-eval', 'scripts/lib']) fs.cpSync(path.join(REPO, dir), path.join(root, dir), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'scripts/z7-sidechain-lib.mjs'), path.join(root, 'scripts/z7-sidechain-lib.mjs'));
    fs.mkdirSync(path.join(root, 'dist/eval'), { recursive: true });
    for (const f of ['eval-stats.js', 'repository-t.js']) fs.copyFileSync(path.join(REPO, 'dist/eval', f), path.join(root, 'dist/eval', f));
    fs.writeFileSync(path.join(root, 'scripts/token-eval/z0-added.mjs'), 'export const added = 1;\n');
    return root;
  };

  it('adds a module a scratch copy of each entry imports', () => {
    for (const entry of ['z0-analyze.mjs', 'z0-size.mjs', 'z0-seed-rule.mjs']) {
      const file = path.join(scratch(), 'scripts/token-eval', entry);
      expect(files(sourceRows(file)).some((f) => f.endsWith('z0-added.mjs')), entry).toBe(false);
      const [shebang, ...rest] = fs.readFileSync(file, 'utf8').split('\n');
      fs.writeFileSync(file, [shebang, "import './z0-added.mjs';", ...rest].join('\n'));
      expect(files(sourceRows(file)).filter((f) => f.endsWith('z0-added.mjs')), entry).toHaveLength(1);
    }
  });
});

describe('inputHashes', () => {
  const setup = () => {
    const dir = tmp();
    for (const [name, text] of Object.entries({ 'runs.jsonl': 'r', 'plan.json': 'p', 'prices.json': 'q', 'a.json': 'oa', 'b.json': 'ob', 'seam.sh': '#!/bin/sh' })) fs.writeFileSync(path.join(dir, name), text);
    fs.mkdirSync(path.join(dir, 'tasks/k'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tasks/k/tasks-run.json'), '{}');
    fs.writeFileSync(path.join(dir, 'tasks/top.txt'), 'top');
    return dir;
  };
  const ARGS = { runs: ['runs.jsonl'], plan: ['plan.json'], prices: 'prices.json', grading: null, dropList: null };

  it('keeps round 3\'s rows, with the source rows of the entry and the two statistics sources', () => {
    const dir = setup();
    const rows = inputHashes(ARGS, dir);
    expect(rows.map((r: { role: string }) => r.role).filter((r: string) => r !== 'source')).toEqual(['runs', 'plan', 'prices']);
    expect(rows[0]).toEqual({ role: 'runs', file: 'runs.jsonl', sha256: sha(path.join(dir, 'runs.jsonl')) });
    expect(files(rows.filter((r: { role: string }) => r.role === 'source'))).toEqual([...files(sourceRows(ENTRY)), 'src/eval/eval-stats.ts', 'src/eval/repository-t.ts']);
    expect(inputHashes({ ...ARGS, prices: null }, dir).map((r: { role: string }) => r.role).slice(0, 3)).toEqual(['runs', 'plan', 'source']);
  });

  it('gives one off-pin row per file, then each extra pair in order: a file by sha256, a folder as a tree', () => {
    const dir = setup();
    const extra = [['seam', 'seam.sh'], ['tasks-tree', 'tasks']];
    const rows = inputHashes({ ...ARGS, offPin: ['a.json', 'b.json'] }, dir, { extra });
    const head = rows.filter((r: { role: string }) => r.role !== 'source');
    expect(head.map((r: { role: string }) => r.role)).toEqual(['runs', 'plan', 'prices', 'off-pin', 'off-pin', 'seam', 'tasks-tree']);
    expect(head[3]).toEqual({ role: 'off-pin', file: 'a.json', sha256: sha(path.join(dir, 'a.json')) });
    expect(head[5]).toEqual({ role: 'seam', file: 'seam.sh', sha256: sha(path.join(dir, 'seam.sh')) });
    expect(head[6]).toEqual({ role: 'tasks-tree', file: 'tasks', sha256: treeHash(path.join(dir, 'tasks')), tree: true });
    fs.writeFileSync(path.join(dir, 'tasks/k/tasks-run.json'), '{ }');
    const after = inputHashes({ ...ARGS, offPin: ['a.json', 'b.json'] }, dir, { extra }).find((r: { role: string }) => r.role === 'tasks-tree');
    expect(after!.sha256).not.toBe(head[6].sha256);
  });

  it('hashes the entry it is given', () => {
    const dir = setup();
    const rows = inputHashes(ARGS, dir, { entry: 'scripts/token-eval/z0-size.mjs' });
    expect(files(rows.filter((r: { role: string }) => r.role === 'source'))).toEqual(expect.arrayContaining(['scripts/token-eval/z0-size.mjs', 'scripts/token-eval/z0-size-sim.mjs']));
  });
});
