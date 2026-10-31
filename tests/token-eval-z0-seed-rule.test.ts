/** Z0 seed rule (Amendment 2 item 5): seed counts from wave-1 records, the stop, the wave-1 refusal, and blindness. */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli, seedRule } from '../scripts/token-eval/z0-seed-rule.mjs';
import { PRICES, generate, jsonl, planOf } from './fixtures/z0-gen.js';
import type { Generated, GenOpts, Z0Record } from './fixtures/z0-gen.js';

vi.setConfig({ testTimeout: 180_000 });

const ARGV = ['--runs', 'runs.jsonl', '--plan', 'plan.json', '--prices', 'prices.json', '--sims', '20'];
// Wave 1 with no spread at all: every unit is zero, so the rule has nothing to add.
const QUIET: GenOpts = { knobs: { A1: { fail: 0, resolve: 1 }, A2: { fail: 0, resolve: 1 }, X2: { fail: 0 }, X3: { fail: 0 } } };

interface Rule {
  schema: string;
  settings: Record<string, number>;
  inputs: { role: string; file: string; sha256: string }[];
  seeds: Record<string, number> | null;
  perHypothesis: Record<string, number | null>;
  stop: boolean;
  reasons: string[];
}
type Run = { code: number; stdout: string; stderr: string; json: Rule | null };

/** Writes the records under a fresh folder (vitest.config.ts removes it) and runs the CLI on them. */
function run(g: Generated, extra: string[] = []): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-seed-rule-'));
  const files = { 'runs.jsonl': jsonl(g.records), 'plan.json': JSON.stringify(g.plan), 'prices.json': JSON.stringify(PRICES) };
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
  const res = runCli([...ARGV, ...extra], dir);
  return { ...res, json: res.code === 0 && !extra.includes('--out') ? JSON.parse(res.stdout) : null };
}

/** A1 and A2 trade places; the corpus check wants `captured` on A2 only. */
const withArmsSwapped = (g: Generated): Generated => {
  const records = g.records.map((r) => {
    const arm = r.arm === 'A1' ? 'A2' : r.arm === 'A2' ? 'A1' : r.arm;
    return { ...r, arm, chain: r.chain && r.arm.startsWith('A') ? { ...r.chain, captured: arm === 'A2' ? true : null } : r.chain };
  });
  return { records, plan: planOf(records) };
};

/** Arm A2 fails every apply task in families 0 and 1 and none elsewhere, in every seed: a pure family spread. */
function familySpread(): Generated {
  const g = generate(QUIET);
  for (const r of g.records) {
    if (r.arm === 'A2' && r.kind === 'apply' && r.lessons[0]) r.lessons[0].first = /-f[01]$/.test(r.familyId ?? '') ? 'fail' : 'pass';
  }
  return g;
}

/** Every key at every depth, read through the reviver, which visits each one. */
const keysOf = (text: string): string[] => {
  const keys: string[] = [];
  JSON.parse(text, (k, v) => { keys.push(k); return v; });
  return keys;
};

describe('Z0 seed rule', () => {
  it('gives every rule arm 3 seeds when wave 1 has no spread, and does not stop', () => {
    const res = run(generate(QUIET));
    expect(res).toMatchObject({ code: 0, stderr: '' });
    expect(res.json).toMatchObject({
      schema: 'z0-seed-rule/1', stop: false, reasons: [],
      seeds: { A1: 3, A2: 3, A5: 3, X2: 3, X3: 3 }, perHypothesis: { H1: 3, H2: 3, H4: 3 },
      settings: { minimumEffect: 0.15, targetZ: 3.5, cap: 9, power: 0.8, sims: 20, seed: 1, bound: 0.8, firstWave: 3 },
    });
    expect(res.json!.inputs.map((i: { role: string }) => i.role)).toEqual(expect.arrayContaining(['runs', 'plan', 'prices', 'source']));
  });

  it('stops after wave 1 when the family spread alone is too big, and says how to size the next run', () => {
    const res = run(familySpread());
    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({ stop: true, seeds: null, perHypothesis: { H1: null, H2: 3 } });
    expect(res.json!.reasons[0]).toBe('H1 needs more than 9 seeds');
    expect(res.json!.reasons.at(-1)).toContain('z0-size.mjs');
  });

  it('prints one line with --out: the seeds, or the stop', () => {
    const quiet = run(generate(QUIET), ['--out', 'rule.json']);
    expect(quiet).toMatchObject({ code: 0, stdout: 'seeds A1 3, A2 3, A5 3, X2 3, X3 3\n' });
    expect(run(familySpread(), ['--out', 'rule.json']).stdout).toMatch(/^stop: H1 needs more than 9 seeds; the run stops after wave 1/);
  });

  it('leaves H2 out when the plan has no X2 and X3', () => {
    const res = run(generate({ ...QUIET, arms: ['A0', 'A1', 'A2', 'A4', 'A5'] }));
    expect(res.json).toMatchObject({ stop: false, seeds: { A1: 3, A2: 3, A5: 3 } });
    expect(Object.keys(res.json!.seeds!)).toEqual(['A1', 'A2', 'A5']);
    expect(Object.keys(res.json!.perHypothesis)).toEqual(['H1', 'H4']);
  });

  it('exits 1 when a scored record has a seed above 3', () => {
    const g = generate(QUIET);
    const late: Z0Record = { ...g.records.find((r) => r.arm === 'A1' && r.seed === 3)!, seed: 4 };
    const records = [...g.records, late];
    const res = run({ records, plan: planOf(records) });
    expect(res).toMatchObject({ code: 1, stdout: '' });
    expect(res.stderr).toContain('the rule reads wave 1 only: a scored record has a seed above 3');
    expect(() => seedRule(records, planOf(records), PRICES, { minimumEffect: 0.15, targetZ: 3.5, cap: 9, power: 0.8, sims: 20, seed: 1, bound: 0.8 })).toThrow('wave 1 only');
  });

  it('exits 1, naming the hypothesis, when no repository can be fitted', () => {
    const records = generate(QUIET).records.filter((r) => !(r.arm === 'A2' && r.kind === 'apply'));
    const res = run({ records, plan: planOf(records) });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('H1: needs A2 and A1 units');
  });

  it('prints no figure that could carry the effect: no key names one, in the result or the stop', () => {
    const banned = ['estimate', 'mean', 'p', 'se', 'F', 'Q', 'E', 'noise', 'family', 'sequence', 'value'];
    for (const g of [generate(QUIET), familySpread()]) {
      const keys = keysOf(run(g).stdout);
      expect(keys).toEqual(expect.arrayContaining(['schema', 'settings', 'inputs', 'seeds', 'perHypothesis', 'stop', 'reasons']));
      expect(keys.filter((k) => banned.includes(k))).toEqual([]);
    }
  });

  it('gives the same seed counts when A1 and A2 swap, since the rule never reads a sign', () => {
    const g = generate({ knobs: { A1: { fail: 0.5, resolve: 1 }, A2: { fail: 0.2, resolve: 1 }, X2: { fail: 0.5 }, X3: { fail: 0.2 } } });
    const [plain, swapped] = [run(g), run(withArmsSwapped(g))];
    expect(plain.json).toMatchObject({ stop: false });
    expect(plain.json!.seeds!.A1!).toBeGreaterThan(3);
    expect(plain.json!.seeds!.X2!).toBeGreaterThan(3);
    expect(swapped.json!.seeds).toEqual(plain.json!.seeds);
    expect(swapped.json!.perHypothesis).toEqual(plain.json!.perHypothesis);
  });
});
