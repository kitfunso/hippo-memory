// Round 4 slice 4b: the unblinded round 4 read through runCli, with the git pattern of the round 3 CLI test.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runDirs } from '../scripts/token-eval/homes.mjs';
import * as analyze from '../scripts/token-eval/z0-analyze.mjs';
import { R4, R4_ARGV, cleanUp, corpus, levelsFile, loose, workspace } from './fixtures/z0-r4-read.js';

afterAll(cleanUp);

const g = corpus();
/** A transcript with one assistant message, so the ledger prices a cell with no record cost. */
const transcript = (model: string) => `${JSON.stringify({ type: 'assistant', message: { id: `m-${model}`, model, usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 } } })}\n`;

function ledgerFolder(dir: string, name: string): string {
  const out = path.join(dir, name);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'runs.jsonl'), g.records.map((r) => JSON.stringify(r)).join('\n'));
  const models = new Map([['O1', 'claude-opus-5-5']]);
  for (const arm of R4.arms) {
    const files = path.join(runDirs(out, 'rn-repo1', arm, 1).claudeConfig, 'projects', 'p');
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(path.join(files, 'one.jsonl'), transcript(models.get(arm) ?? 'claude-sonnet-5-5'));
  }
  return out;
}

function gitWorkspace(over: Record<string, string> = {}) {
  const dir = workspace(g, over);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  for (const [k, v] of [['user.name', 'z0 test'], ['user.email', 'z0@example.invalid'], ['core.hooksPath', '.no-hooks'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  git('add', 'drop.json', 'grading.json');
  git('commit', '-qm', 'drop list and grading');
  const out = ledgerFolder(dir, 'out1');
  fs.mkdirSync(path.join(dir, 'empty'));
  return { dir, out, unblind: (extra: string[] = []) => analyze.runCli([...R4_ARGV, '--drop-list', 'drop.json', '--unblind', '--ledger-runs', 'out1', ...extra], dir) };
}

describe('the unblinded round 4 read through runCli', () => {
  it('opens at valid gates, prints the round 4 block with spend from the ledger folders, and hashes every new input in its order', () => {
    const { dir, out, unblind } = gitWorkspace({ 'b1.json': JSON.stringify(levelsFile('batch-1', 0.999, 'c2')) });
    expect(fs.existsSync(out)).toBe(true);
    const r = unblind(['--out', 'open.json']);
    expect([r.code, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toMatch(/^status: valid$/m);
    expect(r.stdout).toMatch(/^At medium effort and at list prices on 2026-10-11, Sonnet 5\.5 with hippo /m);
    expect(r.stdout).toMatch(/^levels note: minLevels: the levels files were made at different commits, c1 and c2$/m);
    expect(r.stdout).toMatch(/^ {2}recorded spend per paired solve: S2 \$[\d.]+, O1 \$[\d.]+, S1 \$[\d.]+; no verdict$/m);
    expect(r.stdout).not.toMatch(/\bA\d\b/);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'open.json'), 'utf8'));
    expect(report.hypotheses.asOf).toBe('2026-10-11');
    const rows = report.hashes.filter((h: { role: string }) => h.role !== 'source');
    expect(rows.map((h: { role: string }) => h.role)).toEqual(['runs', 'plan', 'prices', 'grading', 'drop-list', 'levels', 'levels', 'seed-rule', 'pins', 'drift-runs', 'drift-plan', 'ledger-runs']);
    expect(rows.at(-1)).toMatchObject({ file: 'out1', tree: true });
  });

  it('enters a test above the pins layout reach at p = 1 with its no-verdict line, and hashes the pins file', () => {
    const rule = JSON.parse(fs.readFileSync(path.join(workspace(g), 'sr.json'), 'utf8'));
    rule.perTest.T3.seeds = 4;
    const { dir, unblind } = gitWorkspace({ 'sr.json': JSON.stringify(rule) });
    const r = unblind(['--out', 'cut.json']);
    expect(r.stdout).toContain('T3 at seeds 1 to 3, below its count 4: no verdict');
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'cut.json'), 'utf8'));
    expect([report.hypotheses.scored.closed.T3.verdict, report.hypotheses.windows.T3.reached, Number.isFinite(report.hypotheses.estimates.T3.violation.estimate)]).toEqual(['no verdict', false, true]);
    expect(report.hashes.some((h: { role: string; file: string }) => h.role === 'pins' && h.file === 'pins.json')).toBe(true);
    const noPins = analyze.runCli(R4_ARGV.filter((_, i) => i < R4_ARGV.indexOf('--pins') || i > R4_ARGV.indexOf('--pins') + 1), dir);
    expect([noPins.code, noPins.stderr]).toEqual([1, expect.stringContaining('--pins')]);
  });

  it('neither hashes nor reads the ledger folders while a gate fails, and exits 1 on one that is no runner output once the codes open; --ledger-runs without --unblind exits 1', () => {
    const bad = loose(g);
    const shut = { ...bad, records: [{ ...bad.records[0], void: 'operator-canary' }, ...bad.records.slice(1)] };
    const { dir } = gitWorkspace({ 'runs.jsonl': shut.records.map((r: any) => JSON.stringify(r)).join('\n') });
    const closed = analyze.runCli([...R4_ARGV, '--drop-list', 'drop.json', '--unblind', '--ledger-runs', 'nowhere', '--out', 'closed.json'], dir);
    expect([closed.code, closed.stderr]).toEqual([0, '']);
    expect(closed.stdout).toContain('invalid: G1');
    expect(closed.stdout).not.toContain('ledger-runs');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'closed.json'), 'utf8')).hashes.some((h: { role: string }) => h.role === 'ledger-runs')).toBe(false);
    const open = gitWorkspace();
    const missing = analyze.runCli([...R4_ARGV, '--drop-list', 'drop.json', '--unblind', '--ledger-runs', 'empty'], open.dir);
    expect([missing.code, missing.stderr]).toEqual([1, expect.stringContaining('empty')]);
    expect(analyze.runCli([...R4_ARGV, '--ledger-runs', 'out1'], open.dir).code).toBe(1);
  });
});
