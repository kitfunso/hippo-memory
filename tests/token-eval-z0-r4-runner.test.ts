// Round 4 slice 2a, plan level: ab-run's --design, the arm order, --max-position, the seed rule /2 and --only-seed, all through --dry-run so no session runs.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ALL_ARMS, ARM_TABLE, DESIGNS } from '../scripts/token-eval/arms.mjs';
import * as abRun from '../scripts/token-eval/ab-run.mjs';

const AB_RUN = resolve(__dirname, '..', 'scripts', 'token-eval', 'ab-run.mjs');
const R4 = DESIGNS.r4.arms;
const RULE_ARMS = DESIGNS.r4.seedRule[0]!.arms;
const FIXED_ARMS = R4.filter((a: string) => !ARM_TABLE[a].seedRule);
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

type Json = string | number | boolean | null | undefined | readonly Json[] | { readonly [key: string]: Json };
type Over = Readonly<Record<string, Json>>;
interface Cell { seed: number; position: number; arm: string; sequence: string; taskId: string }
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** A tasks file of `sequences` sequences with `tasks` no-lesson tasks each; a dry run needs no repository. */
function world(sequences = 1, tasks = 3) {
  const scratch = tmp('r4-runner-');
  const file = join(scratch, 'tasks.json');
  const seqs = Array.from({ length: sequences }, (_, s) => ({
    id: `seq${s}`, cluster: 'c', repo: 'unused', fixedOrder: true,
    tasks: Array.from({ length: tasks }, (_, i) => ({ id: `s${s}t${i}`, kind: 'no-lesson', baseRef: 'b', fixRef: 'f', prompt: `task ${i}`, test: 'node test.js', testFiles: [] })),
  }));
  writeFileSync(file, JSON.stringify({ sequences: seqs }));
  let n = 0;
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const out = join(scratch, `out${n++}`);
    const res = spawnSync(process.execPath, [AB_RUN, '--tasks', file, '--out', out, ...args], { encoding: 'utf8', env: { ...process.env, Z0_ANCESTOR_STOP: scratch, ...env } });
    const planFile = join(out, 'plan.json');
    return { ...res, out, plan: (): Cell[] => JSON.parse(readFileSync(planFile, 'utf8')), planned: existsSync(planFile) };
  };
  let written = 0;
  /** A /2 rule file: the four rule arms at `count`, S0 and S4 at their table seed count; `over` replaces any field. */
  const rule = (count: number, over: Over = {}): string => {
    const seeds = Object.fromEntries(RULE_ARMS.map((a: string) => [a, count]));
    const countsByArm = Object.fromEntries(R4.map((a: string) => [a, ARM_TABLE[a].seedRule ? count : ARM_TABLE[a].seeds]));
    const f = join(scratch, `rule-${written++}.json`);
    writeFileSync(f, JSON.stringify({ schema: 'z0-seed-rule/2', design: 'r4', perTest: {}, seeds, countsByArm, reasons: [], stop: false, ...over }));
    return f;
  };
  return { scratch, file, cli, rule };
}

const seedsOf = (cells: Cell[]) => {
  const by = new Map<string, Set<number>>();
  for (const c of cells) by.set(c.arm, (by.get(c.arm) ?? new Set<number>()).add(c.seed));
  return Object.fromEntries([...by].map(([arm, set]) => [arm, [...set].sort((a, b) => a - b)]));
};
const key = (c: Cell) => `${c.seed}|${c.position}|${c.arm}|${c.sequence}|${c.taskId}`;

describe('ab-run --design', () => {
  it('takes r3 (the default) and r4, and refuses any other name', () => {
    const w = world();
    const bare = w.cli(['--dry-run', '--arms', 'A1,A2']);
    const named = w.cli(['--dry-run', '--design', 'r3', '--arms', 'A1,A2']);
    expect(bare.status, bare.stderr).toBe(0);
    expect(named.stdout).toBe(bare.stdout);
    expect(named.plan().map(key)).toEqual(bare.plan().map(key));
    const r4 = w.cli(['--dry-run', '--design', 'r4']);
    expect(r4.status, r4.stderr).toBe(0);
    expect(new Set(r4.plan().map((c) => c.arm))).toEqual(new Set(R4));
    for (const bad of ['r5', 'r4-on-r3', '']) {
      const res = w.cli(['--dry-run', '--design', bad]);
      expect(res.status, bad).toBe(1);
      expect(res.stderr, bad).toContain(`--design must be r3 or r4, got ${bad}`);
      expect(res.planned, bad).toBe(false);
    }
  });

  it('refuses a round 3 arm under r4 and a round 4 arm under r3, naming the design\'s own arms', () => {
    const w = world();
    const r3arm = w.cli(['--dry-run', '--design', 'r4', '--arms', 'A1']);
    expect(r3arm.status).toBe(1);
    expect(r3arm.stderr).toContain(`unknown arm A1; known: ${R4.join(', ')}`);
    const r4arm = w.cli(['--dry-run', '--arms', 'S1']);
    expect(r4arm.status).toBe(1);
    expect(r4arm.stderr).toContain('unknown arm S1; known: A0, A1, A2, A4, A5, X1, X2, X3, X4');
  });

  it('under r4 refuses --model and --screen; under r3 refuses --effort and --max-position as round 4 only', () => {
    const w = world();
    const model = w.cli(['--dry-run', '--design', 'r4', '--model', 'claude-sonnet-5-5']);
    expect(model.status).toBe(1);
    expect(model.stderr).toContain('the arm table names each arm\'s model (prereg item 5); drop --model');
    const screen = w.cli(['--dry-run', '--design', 'r4', '--screen']);
    expect(screen.status).toBe(1);
    expect(screen.stderr).toContain('--screen is round 3 only');
    for (const [flag, value] of [['--effort', 'medium'], ['--max-position', '1']]) {
      const res = w.cli(['--dry-run', flag, value]);
      expect(res.status, flag).toBe(1);
      expect(res.stderr, flag).toContain(`${flag} is round 4 only`);
      expect(res.planned, flag).toBe(false);
    }
    const sameUnderDesign = w.cli(['--dry-run', '--design', 'r3', '--effort', 'low']);
    expect(sameUnderDesign.stderr).toContain('--effort is round 4 only');
  });

  it('checks --effort and --max-position values', () => {
    const w = world();
    for (const bad of ['meduim', 'LOW', '']) {
      const res = w.cli(['--dry-run', '--design', 'r4', '--effort', bad]);
      expect(res.status, bad).toBe(1);
      expect(res.stderr, bad).toContain(`--effort must be low, medium or high, got ${bad}`);
    }
    for (const bad of ['0', 'abc', '1.5', '-1']) {
      const res = w.cli(['--dry-run', '--design', 'r4', '--max-position', bad]);
      expect(res.status, bad).toBe(1);
      expect(res.stderr, bad).toContain(`--max-position must be a positive integer, got ${bad}`);
    }
    const ok = w.cli(['--dry-run', '--design', 'r4', '--effort', 'high', '--max-position', '2']);
    expect(ok.status, ok.stderr).toBe(0);
  });

  it('a real r4 run needs --pins and --effort, and stops before it clones or opens an out dir', () => {
    const w = world();
    const real = { CLAUDE_CODE_OAUTH_TOKEN: 'fake-tok-x', Z0_ANCESTOR_STOP: '' };
    const noPins = w.cli(['--design', 'r4', '--effort', 'medium'], real);
    expect(noPins.status).toBe(1);
    expect(noPins.stderr).toContain('a round 4 run needs --pins');
    const pins = join(w.scratch, 'pins.json');
    writeFileSync(pins, '{}');
    const noEffort = w.cli(['--design', 'r4', '--pins', pins], real);
    expect(noEffort.status).toBe(1);
    expect(noEffort.stderr).toContain('a round 4 run needs --effort low, medium or high');
    for (const res of [noPins, noEffort]) expect(existsSync(res.out)).toBe(false);
    // A dry run and a homes check need neither.
    expect(w.cli(['--dry-run', '--design', 'r4']).status).toBe(0);
  });

  it('a trailing --pins, an empty --pins and a pins file that is not an object each stop before an out dir', () => {
    const w = world();
    const real = { CLAUDE_CODE_OAUTH_TOKEN: 'fake-tok-x', Z0_ANCESTOR_STOP: '' };
    const base = ['--design', 'r4', '--effort', 'medium'];
    const stops: [string, string[], string][] = [
      ['a trailing --pins', [...base, '--pins'], 'a round 4 run needs --pins'],
      ['an empty --pins', [...base, '--pins', ''], 'a round 4 run needs --pins'],
    ];
    for (const body of ['null', 'false', '0', '[]', '"pins"']) {
      const file = join(w.scratch, `pins-${stops.length}.json`);
      writeFileSync(file, body);
      stops.push([`a pins file holding ${body}`, [...base, '--pins', file], 'must hold a JSON object of pinned values']);
    }
    for (const [what, args, message] of stops) {
      const res = w.cli(args, real);
      expect(res.status, what).toBe(1);
      expect(res.stderr, what).toContain(message);
      expect(existsSync(res.out), what).toBe(false);
    }
    const object = join(w.scratch, 'pins-object.json');
    writeFileSync(object, '{}');
    expect(w.cli(['--dry-run', '--design', 'r4', '--pins', object]).status).toBe(0);
  });

  it('names the new flags in USAGE and says --model is round 3 only', () => {
    const res = spawnSync(process.execPath, [AB_RUN], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    for (const flag of ['--design', '--effort', '--fake-agent', '--max-seed', '--max-position']) expect(res.stderr, flag).toContain(flag);
    expect(res.stderr).toMatch(/--model[^\n]*round 3 only|round 3 only[^\n]*--model/);
  });
});

describe('the r4 plan', () => {
  it('plans each arm at its table seed count, in design order, wherever --arms lists it', () => {
    const w = world();
    const all = w.cli(['--dry-run', '--design', 'r4']);
    expect(all.status, all.stderr).toBe(0);
    expect(seedsOf(all.plan())).toEqual(Object.fromEntries(R4.map((a: string) => [a, Array.from({ length: ARM_TABLE[a].seeds }, (_, i) => i + 1)])));
    expect(all.stdout).toContain(`seeds ${R4.map((a: string) => `${a}:${ARM_TABLE[a].seeds}`).join(' ')}.`);
    const shuffled = w.cli(['--dry-run', '--design', 'r4', '--arms', 'S5,O1,S2,S1']);
    const sorted = w.cli(['--dry-run', '--design', 'r4', '--arms', 'O1,S1,S2,S5']);
    expect(shuffled.plan().map(key)).toEqual(sorted.plan().map(key));
    expect(shuffled.stdout).toContain('seeds O1:3 S1:3 S2:3 S5:3.');
    // Round 3 keeps the order it was given, as it always did.
    const a = w.cli(['--dry-run', '--arms', 'A2,A1']);
    const b = w.cli(['--dry-run', '--arms', 'A1,A2']);
    expect(a.plan().map(key)).not.toEqual(b.plan().map(key));
  });

  it('--max-position n plans positions 1 to n of each sequence: one session per arm and seed at 1', () => {
    const w = world(1, 2);
    const one = w.cli(['--dry-run', '--design', 'r4', '--max-position', '1']);
    expect(one.status, one.stderr).toBe(0);
    const cells = one.plan();
    expect(new Set(cells.map((c) => c.position))).toEqual(new Set([0]));
    expect(cells).toHaveLength(R4.reduce((n: number, a: string) => n + ARM_TABLE[a].seeds, 0));
    expect(one.stdout).toContain(`${cells.length} steps`);
    const full = w.cli(['--dry-run', '--design', 'r4']);
    expect(full.plan().filter((c) => c.position === 0).map(key)).toEqual(cells.map(key));
    // A cap past the sequence's length changes nothing.
    expect(w.cli(['--dry-run', '--design', 'r4', '--max-position', '9']).plan().map(key)).toEqual(full.plan().map(key));
    // Two sequences of three tasks: positions 1 and 2 of each.
    const two = world(2, 3).cli(['--dry-run', '--design', 'r4', '--max-position', '2', '--arms', 'S1']);
    expect(new Set(two.plan().map((c) => c.position))).toEqual(new Set([0, 1]));
    expect(two.plan()).toHaveLength(2 * 2 * 3);
  });

  it('seeds 1 to 3, then a /2 rule at 9, give the rule arms 9 seeds and the fixed arms 2', () => {
    const w = world();
    const first = seedsOf(w.cli(['--dry-run', '--design', 'r4']).plan());
    const raise = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', w.rule(9)]);
    expect(raise.status, raise.stderr).toBe(0);
    const second = seedsOf(raise.plan());
    expect(Object.keys(second)).toEqual(RULE_ARMS);
    for (const arm of R4) expect(new Set([...(first[arm] ?? []), ...(second[arm] ?? [])]).size, arm).toBe(ARM_TABLE[arm].seedRule ? 9 : ARM_TABLE[arm].seeds);
    expect(raise.stdout).toContain(`seeds ${RULE_ARMS.map((a: string) => `${a}:4-9`).join(' ')}.`);
    for (const arm of FIXED_ARMS) expect(second[arm]).toBeUndefined();
  });
});

describe('seed rule /2', () => {
  const only = (arms: string[]) => arms.join(',');

  it('plans seeds 4 and 5 for the four rule arms and none for the fixed arms, at a rule of 5 with --max-seed 5', () => {
    const w = world();
    const res = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', w.rule(5), '--max-seed', '5']);
    expect(res.status, res.stderr).toBe(0);
    expect(seedsOf(res.plan())).toEqual(Object.fromEntries(RULE_ARMS.map((a: string) => [a, [4, 5]])));
  });

  it('--max-seed caps every count, and a rule whose counts are all 3 or less plans no session and writes no plan', () => {
    const w = world();
    const capped = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', w.rule(9), '--max-seed', '5']);
    expect(Math.max(...capped.plan().map((c) => c.seed))).toBe(5);
    for (const [name, args] of [['all at 3', [w.rule(3)]], ['capped to 3', [w.rule(9), '--max-seed', '3']]] as const) {
      const res = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', args[0], ...args.slice(1)]);
      expect(res.status, `${name}: ${res.stderr}`).toBe(0);
      expect(res.stdout.trim(), name).toBe('wave 2 has no sessions');
      expect(existsSync(res.out), name).toBe(false);
    }
    const bad = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', w.rule(5), '--max-seed', 'x']);
    expect(bad.stderr).toContain('--max-seed must be a positive integer, got x');
    const noRule = w.cli(['--dry-run', '--design', 'r4', '--max-seed', '5']);
    expect(noRule.stderr).toContain('--max-seed caps a seed rule\'s counts; pass --seed-rule');
  });

  it('takes /1 under r3 and /2 under r4, and refuses the other', () => {
    const w = world();
    const r4 = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', w.rule(5, { schema: 'z0-seed-rule/1' })]);
    expect(r4.status).toBe(1);
    expect(r4.stderr).toContain('schema must be "z0-seed-rule/2"');
    const r3 = w.cli(['--dry-run', '--arms', 'A1,A2,A5', '--seed-rule', w.rule(5)]);
    expect(r3.status).toBe(1);
    expect(r3.stderr).toContain('schema must be "z0-seed-rule/1"');
  });

  it('refuses a rule that lists a fixed arm in seeds, a countsByArm that disagrees, and a rule arm outside 3 to 9', () => {
    const w = world();
    const seedsOfRule = (over: Record<string, number>) => ({ ...Object.fromEntries(RULE_ARMS.map((a: string) => [a, 5])), ...over });
    const countsOfRule = (over: Record<string, number>) => ({ ...Object.fromEntries(R4.map((a: string) => [a, ARM_TABLE[a].seedRule ? 5 : ARM_TABLE[a].seeds])), ...over });
    const cases: [string, Over, string][] = [];
    for (const fixed of FIXED_ARMS) {
      cases.push([`${fixed} in seeds`, { seeds: seedsOfRule({ [fixed]: 5 }), countsByArm: countsOfRule({ [fixed]: 5 }) }, `${FIXED_ARMS.join(' and ')} run ${ARM_TABLE[fixed].seeds} seeds and never raise (prereg item 1)`]);
      cases.push([`${fixed} at 3 in countsByArm`, { countsByArm: countsOfRule({ [fixed]: 3 }) }, 'countsByArm']);
    }
    cases.push(['a rule arm that differs between seeds and countsByArm', { countsByArm: countsOfRule({ [RULE_ARMS[0]]: 6 }) }, 'countsByArm']);
    cases.push(['countsByArm missing', { countsByArm: undefined }, 'countsByArm']);
    cases.push(['a count of 10', { seeds: seedsOfRule({ [RULE_ARMS[1]]: 10 }), countsByArm: countsOfRule({ [RULE_ARMS[1]]: 10 }) }, `${RULE_ARMS[1]} needs a seed count from 3 to 9, got 10`]);
    cases.push(['a count of 2', { seeds: seedsOfRule({ [RULE_ARMS[2]]: 2 }), countsByArm: countsOfRule({ [RULE_ARMS[2]]: 2 }) }, `${RULE_ARMS[2]} needs a seed count from 3 to 9, got 2`]);
    cases.push(['a stop file', { stop: true }, 'the rule did not say go']);
    for (const [what, over, message] of cases) {
      // A rule arm outside 3 to 9 is refused even when --arms names only another arm.
      const res = w.cli(['--dry-run', '--design', 'r4', '--arms', 'S1', '--seed-rule', w.rule(5, over)]);
      expect(res.status, what).toBe(1);
      expect(res.stderr, what).toContain(message);
      expect(existsSync(res.out), what).toBe(false);
    }
  });

  it('refuses a rule that names another design, leaves a rule arm out, or gives the rule arms different counts', () => {
    const w = world();
    const last: string = RULE_ARMS.at(-1);
    const seedsAt = (n: number): Over => Object.fromEntries(RULE_ARMS.map((a: string) => [a, n]));
    const countsOf = (seeds: Over): Over => Object.fromEntries(R4.map((a: string) => [a, ARM_TABLE[a].seedRule ? seeds[a] : ARM_TABLE[a].seeds]));
    const without = Object.fromEntries(Object.entries(seedsAt(5)).filter(([a]) => a !== last));
    const uneven = { ...seedsAt(5), [RULE_ARMS[0]]: 4 };
    const cases: [string, Over, string][] = [
      ['design r3', { design: 'r3' }, 'design is "r3", not "r4"'],
      ['no design', { design: undefined }, 'design is undefined, not "r4"'],
      [`${last} missing from seeds and countsByArm`, { seeds: without, countsByArm: countsOf(without) }, `seeds lacks ${last}, which the rule sizes`],
      [`${last} missing from countsByArm`, { countsByArm: Object.fromEntries(Object.entries(countsOf(seedsAt(5))).filter(([a]) => a !== last)) }, `countsByArm.${last} is undefined`],
      ['uneven counts', { seeds: uneven, countsByArm: countsOf(uneven) }, 'run the largest count (prereg item 10)'],
    ];
    for (const [what, over, message] of cases) {
      const res = w.cli(['--dry-run', '--design', 'r4', '--arms', 'S1', '--seed-rule', w.rule(5, over)]);
      expect(res.status, what).toBe(1);
      expect(res.stderr, what).toContain(message);
      expect(existsSync(res.out), what).toBe(false);
    }
  });

  it('--only-seed 4 to 9 needs --seed-rule and runs that seed alone, in design order, for arms whose capped count reaches it', () => {
    const w = world();
    const rule = w.rule(5);
    const all = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', rule]);
    const one = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', rule, '--only-seed', '4', '--arms', only(['S5', 'O1', 'S2', 'S1'])]);
    expect(one.status, one.stderr).toBe(0);
    expect(one.stdout).toContain('seeds O1:only 4 S1:only 4 S2:only 4 S5:only 4.');
    expect(one.plan().map(key)).toEqual(all.plan().filter((c) => c.seed === 4).map(key));
    const past = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', rule, '--only-seed', '6', '--arms', only(['S5', 'O1', 'S2', 'S1'])]);
    expect(past.status).toBe(1);
    expect(past.stderr).toContain('--only-seed 6 is past the seed rule\'s count of O1, S1, S2, S5');
    const capped = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', rule, '--max-seed', '4', '--only-seed', '5', '--arms', 'S1']);
    expect(capped.stderr).toContain('--only-seed 5 is past the seed rule\'s count of S1');
    const fixed = w.cli(['--dry-run', '--design', 'r4', '--seed-rule', rule, '--only-seed', '4', '--arms', 'S0']);
    expect(fixed.stderr).toContain('--only-seed 4 is past the seed rule\'s count of S0');
    const noRule = w.cli(['--dry-run', '--design', 'r4', '--only-seed', '5', '--arms', 'S1']);
    expect(noRule.status).toBe(1);
    expect(noRule.stderr).toContain('--only-seed 5 needs --seed-rule');
  });

  it('--only-seed 1 to 3 reads the arm table, and refuses --seed-rule, --seeds and a seed past a fixed arm\'s two', () => {
    const w = world();
    const ok = w.cli(['--dry-run', '--design', 'r4', '--only-seed', '2', '--arms', 'S4,S0']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(seedsOf(ok.plan())).toEqual({ S0: [2], S4: [2] });
    const three = w.cli(['--dry-run', '--design', 'r4', '--only-seed', '3', '--arms', 'S1,S0']);
    expect(three.status).toBe(1);
    expect(three.stderr).toContain('--only-seed 3 is past the prereg seed count of S0');
    const withRule = w.cli(['--dry-run', '--design', 'r4', '--only-seed', '2', '--seed-rule', w.rule(5), '--arms', 'S1']);
    expect(withRule.status).toBe(1);
    expect(withRule.stderr).toContain('--only-seed 2 reads the arm table; --seed-rule is for seeds 4 to 9');
    const withSeeds = w.cli(['--dry-run', '--design', 'r4', '--only-seed', '2', '--seeds', '2', '--arms', 'S1']);
    expect(withSeeds.stderr).toContain('--only-seed cannot be combined with --seeds');
  });

  it('a trailing --seeds or --only-seed stops instead of planning every seed', () => {
    const w = world();
    for (const [design, arm] of [['r3', 'A1'], ['r4', 'S1']]) {
      for (const flag of ['--seeds', '--only-seed']) {
        const res = w.cli(['--dry-run', '--design', design!, '--arms', arm!, flag]);
        expect(res.status, `${design} ${flag}`).toBe(1);
        expect(res.stderr, `${design} ${flag}`).toContain(`${flag} must be a positive integer`);
        expect(res.planned, `${design} ${flag}`).toBe(false);
      }
    }
  });

  it('under r3 --only-seed keeps today\'s rules, --seed-rule refusal included', () => {
    const w = world();
    const f = join(w.scratch, 'r3-rule.json');
    writeFileSync(f, JSON.stringify({ schema: 'z0-seed-rule/1', stop: false, seeds: { A1: 5, A2: 5, A5: 5 } }));
    const res = w.cli(['--dry-run', '--only-seed', '4', '--seed-rule', f, '--arms', 'A1']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--only-seed cannot be combined with --seeds, --seed-rule or --screen');
    const past = w.cli(['--dry-run', '--only-seed', '4', '--arms', 'A1']);
    expect(past.stderr).toContain('--only-seed 4 is past the prereg seed count of A1');
  });

  it('every arm of the table has its seed count in ARM_SEEDS, so the cap works for the round 4 arms', async () => {
    const { ARM_SEEDS } = await import('../scripts/token-eval/arms.mjs');
    expect(Object.keys(ARM_SEEDS)).toEqual([...ALL_ARMS]);
    for (const arm of ALL_ARMS) expect(ARM_SEEDS[arm], arm).toBe(ARM_TABLE[arm].seeds);
  });
});

describe('the run options main builds', () => {
  const argvOf = (w: ReturnType<typeof world>, more: string[]) => ['node', 'ab-run.mjs', '--tasks', w.file, '--out', join(w.scratch, 'run-out'), ...more];
  const codexOpts = {};

  it('carry the design, effort, max position, pins, warm-up switch and upstream the command line chose under r4', () => {
    const w = world();
    const pins = join(w.scratch, 'pins.json');
    writeFileSync(pins, JSON.stringify({ hippoCommit: 'c' }));
    const args = abRun.parseArgs(argvOf(w, ['--design', 'r4', '--effort', 'high', '--max-position', '2', '--pins', pins, '--arms', 'S1,S2', '--seeds', '2', '--no-warmup', '--settle-ms', '7']));
    const opts = abRun.runOptions(args, { progress: { last: 'none' }, upstream: 'http://127.0.0.1:9', codexOpts });
    expect(opts).toMatchObject({
      design: DESIGNS.r4, effort: 'high', maxPosition: 2, pins: { hippoCommit: 'c' }, warmup: false, settleMs: 7, upstream: 'http://127.0.0.1:9',
      arms: ['S1', 'S2'], seeds: 2, outDir: resolve(join(w.scratch, 'run-out')), model: null, claudeBin: 'claude',
    });
  });

  it('carry round 3\'s own values under r3: no effort, no position cap, the --model flag, the warm-up on', () => {
    const w = world();
    const args = abRun.parseArgs(argvOf(w, ['--model', 'claude-x', '--arms', 'A1']));
    const opts = abRun.runOptions(args, { progress: { last: 'none' }, upstream: null, codexOpts });
    expect(opts).toMatchObject({ design: DESIGNS.r3, effort: undefined, maxPosition: Infinity, model: 'claude-x', warmup: true, upstream: null, pins: null });
    expect(Object.keys(opts)).toEqual(expect.arrayContaining(['design', 'effort', 'maxPosition']));
  });
});
