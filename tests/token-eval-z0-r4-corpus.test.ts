// Round 4 corpus row (prereg line 105): one corpus through every round 4 CLI, each run once.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli as analyzeCli } from '../scripts/token-eval/z0-analyze.mjs';
import { BLOCK_SCHEMA } from '../scripts/token-eval/z0-batch1-block.mjs';
import { spendByArm } from '../scripts/token-eval/z0-ledger.mjs';
import { runCli as pilotCli } from '../scripts/token-eval/z0-pilot.mjs';
import { SEED_RULE_SCHEMA } from '../scripts/token-eval/z0-records.mjs';
import { runCli as seedRuleCli } from '../scripts/token-eval/z0-seed-rule.mjs';
import { runCli as sizeCli } from '../scripts/token-eval/z0-size.mjs';
import { R3_FIGURE, WHOLE_PLANS, corpusWorkspace, ledgerFolder, pilotArgv, r4Corpus, raisedReadSet } from './fixtures/z0-r4-corpus.js';
import { PRICES4, R4, cleanUp, raise } from './fixtures/z0-r4-read.js';

// The unblind's 10,000 resamples make this file about 10 s.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
afterAll(cleanUp);

const COMMON = ['--design', 'r4', '--read-set', 'rs1.txt', '--prices', 'prices.json', '--grading', 'grading.json', '--drop-list', 'drop.json'];
const LEVELS = ['--levels', 'pre.json', '--levels', 'b1.json'];
const WHOLE = Array.from({ length: WHOLE_PLANS }, (_, i) => ['--whole-plan', `whole-${i + 1}.json`]).flat();
const ANALYZE = ['--design', 'r4', '--read-set', 'rs2.txt', '--prices', 'prices.json', '--grading', 'grading.json', ...LEVELS,
  '--seed-rule', 'rule.json', '--pins', 'pins.json', '--drift-runs', 'dr.jsonl', '--drift-plan', 'dp.json'];

const readJson = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

function commitGates(dir: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  for (const [key, value] of Object.entries({ 'user.name': 'z0 test', 'user.email': 'z0@example.invalid', 'core.hooksPath': '.no-hooks', 'commit.gpgsign': 'false' })) git('config', key, value);
  git('add', 'drop.json', 'grading.json');
  git('commit', '-qm', 'drop list and grading');
}

/** The lines that are blank, hold n/a as a word, or hold an A code as a word; the lines hold absolute paths, and only the word bounds keep a path from matching A\d. */
function flagged(text: string): string[] {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  return lines.filter((line) => line.trim() === '' || /\bn\/a\b/.test(line) || /\bA\d\b/.test(line));
}

function runAll() {
  const g = r4Corpus();
  const dir = corpusWorkspace(g);
  const rule = seedRuleCli([...COMMON, '--cost-ratio', '1', ...LEVELS, '--sims', '20', '--out', 'rule.json'], dir);
  const power = sizeCli([...COMMON, ...WHOLE, '--power', '--cost-ratio', '1', ...LEVELS, '--spend-basis', 'spend-basis.json', '--r3-unblind', 'r3-unblind.stdout', '--sims', '20', '--out', 'power.json'], dir);
  const block = sizeCli([...COMMON, ...WHOLE, '--batch1-block', '--key', 'block-key.json', '--out', 'block.json'], dir);
  const top = Math.max(...Object.values<number>(readJson(dir, 'rule.json').seeds));
  raisedReadSet(dir, g, top);
  const blind = analyzeCli([...ANALYZE, '--key', 'key.json', '--out', 'blind.json'], dir);
  commitGates(dir);
  const ledger = ledgerFolder(dir, raise(g, top).records);
  const unblind = analyzeCli([...ANALYZE, '--drop-list', 'drop.json', '--unblind', '--ledger-runs', 'out1', '--out', 'unblind.json'], dir);
  const spend = spendByArm({ runs: [ledger], prices: PRICES4, design: R4 });
  const pilot = pilotCli(pilotArgv(dir, g), path.join(dir, 'pilot'));
  return {
    rule, power, block, blind, unblind, pilot, spend,
    ruleJson: readJson(dir, 'rule.json'), powerJson: readJson(dir, 'power.json'), blockJson: readJson(dir, 'block.json'),
    blindJson: readJson(dir, 'blind.json'), unblindJson: readJson(dir, 'unblind.json'), pilotJson: readJson(path.join(dir, 'pilot'), 'pilot.json'),
  };
}

interface Row { role: string; sha256: string }
const rolesOf = (rows: readonly Row[]): string[] => rows.map((row) => row.role).filter((role) => role !== 'source');
const times = (role: string, n: number): string[] => Array.from({ length: n }, () => role);
const ARMS = ['O1', 'S0', 'S1', 'S2', 'S4', 'S5'];
const BUCKETS = ['0-1', '2-4', '5-9', '10+'];
const PILOT_CHECK_IDS = ['off-pin', 'effort', 'venv', 'env-keys', 'cost-usd', 'r'];
const MAIN = ['runs', 'plan', 'prices', 'grading'];
const RULE_ROLES = [...MAIN, 'drop-list', 'off-pin', 'levels', 'levels', 'read-set', 'merge-manifest'];
const POWER_ROLES = [...MAIN, 'drop-list', 'off-pin', ...times('whole-plan', WHOLE_PLANS), 'levels', 'levels', 'spend-basis', 'r3-unblind', 'read-set', 'merge-manifest'];
const BLIND_ROLES = [...MAIN, 'off-pin', 'levels', 'levels', 'seed-rule', 'read-set', 'merge-manifest', 'pins', 'drift-runs', 'drift-plan'];
const UNBLIND_ROLES = [...MAIN, 'drop-list', 'off-pin', 'levels', 'levels', 'seed-rule', 'read-set', 'merge-manifest', 'pins', 'drift-runs', 'drift-plan', 'ledger-runs'];
const PILOT_ROLES = ['runs', 'runs', 'plan', 'plan', 'prices', ...times('off-pin', 4), ...times('effort-runs', 4), 'pilot-tasks', 'pins', 'spend-basis', ...times('venv', 6)];

describe('the round 4 corpus row through every round 4 CLI', () => {
  let r: ReturnType<typeof runAll>;
  beforeAll(() => {
    r = runAll();
  });

  it('every round 4 CLI exits 0 on the corpus', () => {
    const runs = [r.rule, r.power, r.block, r.blind, r.unblind, r.pilot];
    expect(runs.map((x) => x.code), runs.map((x) => x.stderr).join('')).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('no CLI prints an empty, n/a or A-coded line, apart from the round 3 line --r3-unblind quotes', () => {
    const named: [string, { stdout: string; stderr: string }][] = [['seed rule', r.rule], ['block', r.block], ['blind read', r.blind], ['unblind read', r.unblind], ['pilot', r.pilot]];
    for (const [name, run] of named) {
      expect(flagged(run.stdout), `${name} stdout`).toEqual([]);
      expect(flagged(run.stderr), `${name} stderr`).toEqual([]);
    }
    expect(flagged(r.power.stdout)).toEqual([`T3 round 3 r3-unblind.stdout line 27: ${R3_FIGURE}`]);
    expect(flagged(r.power.stderr)).toEqual([]);
  });

  it('the power read sizes the whole plan', () => {
    expect(r.power.stdout.split('\n')[0]).toBe(`${WHOLE_PLANS} repositories`);
  });

  it('the /2 file holds the rule arms in seeds and all six arms in countsByArm', () => {
    const rule = r.ruleJson;
    expect([rule.schema, rule.design, rule.stop]).toEqual([SEED_RULE_SCHEMA, 'r4', false]);
    expect(Object.keys(rule.seeds).sort()).toEqual(['O1', 'S1', 'S2', 'S5']);
    for (const n of Object.values<number>(rule.seeds)) {
      expect(Number.isInteger(n) && n >= 3 && n <= 9, `seeds ${n}`).toBe(true);
    }
    expect(rule.countsByArm).toEqual({ ...rule.seeds, S0: 2, S4: 2 });
    expect(Object.keys(rule.countsByArm).sort()).toEqual([...R4.arms].sort());
  });

  it('ratesBySinceTeach holds every arm in every bucket with a rate under both codings', () => {
    const rates = r.unblindJson.reported.ratesBySinceTeach;
    expect(Object.keys(rates)).toEqual(BUCKETS);
    for (const bucket of Object.keys(rates)) {
      expect(Object.keys(rates[bucket]).sort(), bucket).toEqual(ARMS);
      for (const arm of Object.keys(rates[bucket])) {
        for (const coding of ['violation', 'excluded']) {
          const rate = rates[bucket][arm][coding];
          expect(rate, `${bucket} ${arm} ${coding}`).not.toBe('n/a');
          expect(Number.isFinite(rate.estimate), `${bucket} ${arm} ${coding} estimate`).toBe(true);
        }
      }
    }
  });

  it('each JSON holds one hash row per role given', () => {
    const cases: [string, Row[], string[]][] = [
      ['seed rule inputs', r.ruleJson.inputs, RULE_ROLES], ['power read inputs', r.powerJson.inputs, POWER_ROLES],
      ['blind hashes', r.blindJson.hashes, BLIND_ROLES], ['unblind hashes', r.unblindJson.hashes, UNBLIND_ROLES], ['pilot hashes', r.pilotJson.hashes, PILOT_ROLES],
    ];
    for (const [name, rows, roles] of cases) {
      expect(rolesOf(rows), name).toEqual(roles);
      for (const row of rows) expect(row.sha256, `${name} ${row.role}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the batch 1 block writes no stop and prints the corpus's whole plan", () => {
    expect(r.blockJson).toEqual({ schema: BLOCK_SCHEMA, stops: [] });
    expect(r.block.stdout.split('\n')).toContain('whole plan: 8 repositories, 4 in batch 1; 528 planned positions, 0 reached by off-pin voids; 24 planned (sequence, seed)s, 0 leaked');
  });

  it("the blind read prints one K line per arm, with the corpus's record counts", () => {
    const counts = r.blind.stdout.split('\n').flatMap((line) => /^K\d+: (\d+ records of \d+ planned);/.exec(line)?.[1] ?? []);
    expect(counts.sort()).toEqual([...times('176 records of 176 planned', 2), ...times('792 records of 792 planned', 4)]);
  });

  it('the ledger prices all six arms, and the unblind reads a spend per solve for S2, O1 and S1', () => {
    expect(Object.keys(r.spend)).toEqual(ARMS);
    for (const [arm, usd] of Object.entries(r.spend)) expect(Number.isFinite(usd) && usd > 0, `${arm} spend ${usd}`).toBe(true);
    const perSolve = r.unblindJson.hypotheses.readouts.spendPerSolve;
    for (const arm of ['S2', 'O1', 'S1']) expect(Number.isFinite(perSolve[arm]) && perSolve[arm] > 0, `${arm} spend per solve ${perSolve[arm]}`).toBe(true);
  });

  it("the pilot passes its six checks on the corpus's O1, S1 and S2 records", () => {
    const lines = r.pilot.stdout.split('\n');
    for (const id of PILOT_CHECK_IDS) expect(lines, id).toContain(`check ${id} pass`);
    expect(r.pilotJson.checks).toEqual(Object.fromEntries(PILOT_CHECK_IDS.map((id) => [id, 'pass'])));
  });
});
