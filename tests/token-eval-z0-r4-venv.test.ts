// Round 4 slice 2b, the task venv: the task env, the --venv command line, and (where the box has Python 3.12 and uv 0.10.9) one real venv per task through runAll, the cleanup and the regrade.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as abRun from '../scripts/token-eval/ab-run.mjs';
import { ARM_TABLE, DESIGNS, ENV_ALLOWLIST, SONNET_MODEL, TASK_KEYS, allowlistOf, armEnv, taskEnv, warmupEnv } from '../scripts/token-eval/arms.mjs';
import { createVenv, runDirs } from '../scripts/token-eval/homes.mjs';
import { openContext, startRun } from '../scripts/token-eval/runs.mjs';
import { runTask } from '../scripts/token-eval/task.mjs';
import { driverOf } from '../scripts/token-eval/codex-task.mjs';
import { parseArgs as regradeArgs } from '../scripts/token-eval/z0-regrade.mjs';
import { startStubUpstream } from '../scripts/token-eval/proxy.mjs';
import { cleanup, tmp, isolate, makeRepo, family, lesson, task, teach, apply, plain, run, readRecords, runRoot, fixtureEnv, CHECKS, type FixtureRepo, type TaskDef } from './fixtures/z0-harness.js';
import { cli, rowsOf } from './fixtures/z0-regrade.js';
import { PRICES_BY_MODEL } from './fixtures/z0-gen.js';

const BUILD = { hippoCommit: 'c'.repeat(40), hippoDirty: false, hippoDistHash: 'd'.repeat(64) };
const TOKEN = 'fake-tok-venv';
const R4 = DESIGNS.r4.arms;
const FAKE_AGENT = resolve(__dirname, 'fixtures', 'fake-claude.mjs');
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
beforeEach(() => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
});
afterEach(() => {
  cleanup();
  for (const k of ['FAKE_CLAUDE_LIMIT_ONCE', 'VIRTUAL_ENV', 'PIP_CONSTRAINT', 'PYTHONDONTWRITEBYTECODE']) delete process.env[k];
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
});

type Json = string | number | boolean | null | undefined | readonly Json[] | { readonly [key: string]: Json };
const jsonl = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
interface Wire { taskId: string; invalid: string | null; envKeys: string[]; limitRetries: number; venvResumed?: boolean; void: string | null; voidHits?: { class: string | null }[] }
const wire = (out: string) => jsonl<Wire>(join(out, 'runs.jsonl'));
const sorted = (list: readonly string[]) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();

describe('TASK_KEYS and taskEnv', () => {
  const venv = resolve('venv-root', '3');
  const poetryDir = resolve('poetry-root');
  const base = { Path: ['C:\\a', 'C:\\b'].join(delimiter), KEEP: '1' };

  it('names VIRTUAL_ENV and PIP_CONSTRAINT, frozen', () => {
    expect([...TASK_KEYS]).toEqual(['VIRTUAL_ENV', 'PIP_CONSTRAINT']);
    expect(Object.isFrozen(TASK_KEYS)).toBe(true);
  });

  it('sets both names and puts the venv\'s and poetry\'s Scripts folders first on the PATH key the env already has', () => {
    const env = taskEnv(base, venv, { poetryDir, pipConstraint: 'C:/c.txt' });
    expect(env).toEqual({ Path: [join(venv, 'Scripts'), join(poetryDir, 'Scripts'), base.Path].join(delimiter), KEEP: '1', VIRTUAL_ENV: venv, PIP_CONSTRAINT: 'C:/c.txt' });
    expect(base).toEqual({ Path: ['C:\\a', 'C:\\b'].join(delimiter), KEEP: '1' });
  });

  it('drops an earlier task\'s two names in any case, so no second key is left', () => {
    const env = taskEnv({ ...base, virtual_env: 'old', Pip_Constraint: 'old' }, venv, { poetryDir, pipConstraint: 'C:/c.txt' });
    for (const name of TASK_KEYS) expect(Object.keys(env).filter((k) => k.toUpperCase() === name)).toEqual([name]);
    expect(env.VIRTUAL_ENV).toBe(venv);
  });

  it('an env with no PATH gets just the two Scripts folders, and an empty PATH adds no trailing separator', () => {
    for (const bare of [{}, { PATH: '' }]) {
      const env = taskEnv(bare, venv, { poetryDir, pipConstraint: 'C:/c.txt' });
      expect(env.PATH).toBe([join(venv, 'Scripts'), join(poetryDir, 'Scripts')].join(delimiter));
    }
  });
});

describe('armEnv and the task keys', () => {
  const dirs = runDirs(resolve('out-x'), 'seqF', 'S1', 1);
  const base = { PATH: process.env.PATH ?? '', HOME: 'C:/h', VIRTUAL_ENV: 'C:/launch/venv', pip_constraint: 'C:/launch/c.txt' };
  const namesIn = (env: Record<string, string | undefined>) => Object.keys(env).map((k) => k.toUpperCase());

  it('a round 4 arm gets neither name from the launcher env, under either allowlist', () => {
    for (const allowlist of [allowlistOf(DESIGNS.r4), ENV_ALLOWLIST]) {
      for (const arm of R4) {
        const names = namesIn(armEnv(arm, runDirs(resolve('out-x'), 'seqF', arm, 1), base, { allowlist }));
        expect(names, arm).not.toContain('VIRTUAL_ENV');
        expect(names, arm).not.toContain('PIP_CONSTRAINT');
      }
    }
    expect(namesIn(warmupEnv(DESIGNS.r4, SONNET_MODEL, dirs, base).env)).not.toContain('VIRTUAL_ENV');
  });

  it('refuses --pass-env of either name under round 4, in any case, naming it', () => {
    for (const name of ['VIRTUAL_ENV', 'virtual_env', 'PIP_CONSTRAINT', 'Pip_Constraint']) {
      expect(() => armEnv('S1', dirs, base, { passEnv: [name] }), name).toThrow(`--pass-env ${name}: the runner sets ${name.toUpperCase()} itself per task, so it cannot be passed through`);
    }
  });

  it('a round 3 arm is as before: VIRTUAL_ENV is allowlisted and passable, and PIP_CONSTRAINT is dropped', () => {
    expect(ARM_TABLE.A1.round).toBe('r3');
    const r3 = runDirs(resolve('out-x'), 'seqF', 'A1', 1);
    expect(armEnv('A1', r3, base, { passEnv: ['VIRTUAL_ENV'] }).VIRTUAL_ENV).toBe('C:/launch/venv');
    expect(armEnv('A1', r3, base).VIRTUAL_ENV).toBe('C:/launch/venv');
    expect(namesIn(armEnv('A1', r3, base))).not.toContain('PIP_CONSTRAINT');
  });
});

/** A tasks file's folder with a tasks file of `sequences` x `tasks` plain tasks; a dry run needs no repository. */
function world() {
  const scratch = tmp('r4-venv-world-');
  const file = join(scratch, 'tasks.json');
  const tasks = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, kind: 'no-lesson', baseRef: 'b', fixRef: 'f', prompt: `task ${i}`, test: 'node test.js', testFiles: [] }));
  writeFileSync(file, JSON.stringify({ sequences: [{ id: 'seq0', cluster: 'c', repo: 'unused', fixedOrder: true, tasks }] }));
  const poetry = join(scratch, 'poetry');
  mkdirSync(poetry);
  const constraint = join(scratch, 'constraints.txt');
  writeFileSync(constraint, 'poetry==2.5.1\n');
  let n = 0;
  const cliRun = (args: string[]) => {
    const out = join(scratch, `out${n++}`);
    const res = spawnSync(process.execPath, [resolve(__dirname, '..', 'scripts', 'token-eval', 'ab-run.mjs'), '--tasks', file, '--out', out, ...args], { encoding: 'utf8', env: { ...process.env, Z0_ANCESTOR_STOP: scratch } });
    return { ...res, planned: existsSync(join(out, 'plan.json')) };
  };
  const argv = (more: string[]) => ['node', 'ab-run.mjs', '--tasks', file, '--out', join(scratch, 'run-out'), '--dry-run', ...more];
  return { scratch, file, poetry, constraint, cliRun, argv };
}

describe('the --venv command line', () => {
  it('under r3 each of --venv, --poetry and --pip-constraint exits 1 as round 4 only', () => {
    const w = world();
    for (const more of [['--venv'], ['--poetry', w.poetry], ['--pip-constraint', w.constraint]]) {
      const res = w.cliRun(['--dry-run', '--arms', 'A1', ...more]);
      expect(res.status, more[0]).toBe(1);
      expect(res.stderr, more[0]).toContain(`${more[0]} is round 4 only (pass --design r4)`);
      expect(res.planned, more[0]).toBe(false);
    }
  });

  it('under r4 --venv needs both value flags, and a trailing or empty value counts as missing', () => {
    const w = world();
    const need = '--venv needs --poetry <dir> and --pip-constraint <file>';
    const cases = [
      ['--venv'], ['--venv', '--poetry', w.poetry], ['--venv', '--pip-constraint', w.constraint], ['--venv', '--poetry', w.poetry, '--pip-constraint'],
      ['--venv', '--poetry', '', '--pip-constraint', w.constraint], ['--venv', '--poetry', w.poetry, '--pip-constraint', ''], ['--venv', '--pip-constraint', w.constraint, '--poetry'],
    ];
    for (const more of cases) {
      const res = w.cliRun(['--dry-run', '--design', 'r4', '--arms', 'S1', ...more]);
      expect(res.status, more.join(' ')).toBe(1);
      expect(res.stderr, more.join(' ')).toContain(need);
      expect(res.planned, more.join(' ')).toBe(false);
    }
  });

  it('under r4 either value flag without --venv exits 1', () => {
    const w = world();
    for (const more of [['--poetry', w.poetry], ['--pip-constraint', w.constraint], ['--poetry', w.poetry, '--pip-constraint', w.constraint]]) {
      const res = w.cliRun(['--dry-run', '--design', 'r4', '--arms', 'S1', ...more]);
      expect(res.status, more.join(' ')).toBe(1);
      expect(res.stderr, more.join(' ')).toContain('--poetry and --pip-constraint go with --venv');
    }
  });

  it('a --poetry that is not a folder, or a --pip-constraint that is not a file, exits 1 naming the flag and the path', () => {
    const w = world();
    const missing = join(w.scratch, 'nope');
    const notDir = w.cliRun(['--dry-run', '--design', 'r4', '--arms', 'S1', '--venv', '--poetry', w.constraint, '--pip-constraint', w.constraint]);
    expect(notDir.status).toBe(1);
    expect(notDir.stderr).toContain('--poetry');
    expect(notDir.stderr).toContain(w.constraint);
    const notFile = w.cliRun(['--dry-run', '--design', 'r4', '--arms', 'S1', '--venv', '--poetry', w.poetry, '--pip-constraint', w.poetry]);
    expect(notFile.status).toBe(1);
    expect(notFile.stderr).toContain('--pip-constraint');
    expect(notFile.stderr).toContain(w.poetry);
    const absent = w.cliRun(['--dry-run', '--design', 'r4', '--arms', 'S1', '--venv', '--poetry', missing, '--pip-constraint', w.constraint]);
    expect(absent.status).toBe(1);
    expect(absent.stderr).toContain(missing);
  });

  it('a full set is accepted and plans', () => {
    const w = world();
    const res = w.cliRun(['--dry-run', '--design', 'r4', '--arms', 'S1', '--venv', '--poetry', w.poetry, '--pip-constraint', w.constraint]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.planned).toBe(true);
  });

  it('a trailing or empty --arms stops under both designs', () => {
    const w = world();
    for (const design of ['r3', 'r4']) {
      for (const tail of [[], ['']]) {
        const res = w.cliRun(['--dry-run', '--design', design, '--arms', ...tail]);
        expect(res.status, `${design} ${tail.length}`).toBe(1);
        expect(res.stderr, `${design} ${tail.length}`).toContain('--arms needs a comma-separated list of arm codes');
        expect(res.planned, `${design} ${tail.length}`).toBe(false);
      }
    }
  });

  it('parseArgs gives absolute paths in venv, and runOptions passes venv on (null under r3 and without --venv)', () => {
    const w = world();
    const codexOpts = {};
    const args = abRun.parseArgs(w.argv(['--design', 'r4', '--arms', 'S1', '--venv', '--poetry', w.poetry, '--pip-constraint', w.constraint]));
    expect(args.venv).toEqual({ poetryDir: resolve(w.poetry), pipConstraint: resolve(w.constraint) });
    const opts = abRun.runOptions(args, { progress: { last: 'none' }, upstream: null, codexOpts });
    expect(opts.venv).toEqual({ poetryDir: resolve(w.poetry), pipConstraint: resolve(w.constraint) });
    for (const more of [['--design', 'r4', '--arms', 'S1'], ['--arms', 'A1']]) {
      const plain = abRun.runOptions(abRun.parseArgs(w.argv(more)), { progress: { last: 'none' }, upstream: null, codexOpts });
      expect(Object.keys(plain)).toContain('venv');
      expect(plain.venv).toBeNull();
    }
  });
});

describe('venvImports in a tasks file', () => {
  const spec = (venvImports: Json) => ({ sequences: [{ id: 's', cluster: 'c', repo: 'r', tasks: [
    { id: 't1', kind: 'no-lesson', baseRef: 'b', fixRef: 'f', prompt: 'p', test: 'node test.js', testFiles: [], venvImports }, { id: 't2', kind: 'no-lesson', baseRef: 'b', fixRef: 'f', prompt: 'p', test: 'node test.js', testFiles: [] },
  ] }] });

  it('takes a list of module names, or none', () => {
    expect(() => abRun.validateTasks(spec(['numpy', 'a.b', '_x1', 'A_1.b2']))).not.toThrow();
    expect(() => abRun.validateTasks(spec([]))).not.toThrow();
    expect(() => abRun.validateTasks(spec(undefined))).not.toThrow();
  });

  it('refuses anything else, naming the task', () => {
    for (const bad of ['numpy', 7, null, {}, [1], [''], ['1a'], ['a b'], ['a-b'], ['a;b'], ['a', 'b c'], [['a']]]) {
      expect(() => abRun.validateTasks(spec(bad)), JSON.stringify(bad)).toThrow(/task t1.*venvImports/);
    }
  });
});

describe('z0-regrade takes --poetry and --pip-constraint together', () => {
  const base = ['regrade', '--out', 'o', '--tasks', 't.json'];

  it('passes both through, and neither is the default', () => {
    expect(regradeArgs([...base, '--poetry', 'p', '--pip-constraint', 'c.txt'])).toMatchObject({ poetry: 'p', pipConstraint: 'c.txt' });
    expect(regradeArgs(base)).not.toHaveProperty('poetry');
    expect(regradeArgs(base)).not.toHaveProperty('pipConstraint');
  });

  it('refuses one without the other, naming both', () => {
    for (const more of [['--poetry', 'p'], ['--pip-constraint', 'c.txt']]) {
      expect(() => regradeArgs([...base, ...more]), more[0]).toThrow(/--poetry.*--pip-constraint|--pip-constraint.*--poetry/);
    }
  });

  it('is a regrade flag only', () => {
    expect(() => regradeArgs(['reader', '--out', 'o', '--poetry', 'p'])).toThrow(/unknown flag --poetry/);
  });

  it('refuses an empty value, as the runner does, naming the flag', () => {
    for (const more of [['--poetry', '', '--pip-constraint', 'c.txt'], ['--poetry', 'p', '--pip-constraint', '']]) {
      expect(() => regradeArgs([...base, ...more]), more.join(' ')).toThrow(new RegExp(`regrade: ${more[more.indexOf('') - 1]} needs a value`));
    }
  });
});

describe('createVenv', () => {
  // A path rmSync rejects stands for a folder it cannot clear: either way the throw must name the venv.
  it('names the venv folder when it cannot clear it, and still throws', () => {
    const venv = join(tmp('r4-venv-clear-'), 'venv', 'bad\0name');
    expect(() => createVenv(venv, process.env, dirname(venv))).toThrow(`could not clear ${venv}`);
  });
});

// ---- the runs below use real knobs, a stub upstream and a probe wrapper around the fake agent ----

interface Knobs { file: string; cmd: string }
function knobs(): Knobs {
  const dir = tmp('r4-venv-knobs-');
  const prices = join(dir, 'prices.json');
  writeFileSync(prices, JSON.stringify(PRICES_BY_MODEL));
  const usage = { input: 1000, output: 2000, cacheRead: 50_000, cacheWrite: 4000 };
  const file = join(dir, 'knobs.json');
  writeFileSync(file, JSON.stringify({
    schema: 'z0-fake-knobs/1', token: TOKEN, calls: join(dir, 'calls.jsonl'), prices, version: '9.9.9', usage: Object.fromEntries(R4.map((a: string) => [a, usage])),
    effortScale: { low: 0.5, medium: 1, high: 2 }, outcome: Object.fromEntries(R4.map((a: string) => [a, { lesson: 0.5, solve: 0.5 }])), leaks: [], offPin: [], fail: [], warmupFail: [],
  }));
  return { file, cmd: `"${process.execPath}" "${FAKE_AGENT}" --fake-knobs "${file}"` };
}

interface Ev { step: string; venv: string | null; pip: string | null; path: string; stale?: boolean | null; calls?: number; note?: boolean | null }

/** The scripts a venv run logs through: `step.mjs` (setup and test commands), `checks/lesson.mjs` (the checker) and `probe.mjs` (the agent), all appending to one events log. */
function toolbox(uv: string | null) {
  const dir = tmp('r4-venv-tools-');
  const log = join(dir, 'events.jsonl');
  const state = join(dir, 'state');
  mkdirSync(join(dir, 'checks'), { recursive: true });
  mkdirSync(state);
  const put = (file: string, lines: string[]) => writeFileSync(join(dir, file), `${lines.join('\n')}\n`);
  const head = [
    "import * as fs from 'node:fs';", "import * as path from 'node:path';", "import { spawnSync } from 'node:child_process';",
    `const LOG = ${JSON.stringify(log)};`, `const STATE = ${JSON.stringify(state)};`, `const UV = ${JSON.stringify(uv)};`,
    "const record = (step, more = {}) => fs.appendFileSync(LOG, JSON.stringify({ step, venv: process.env.VIRTUAL_ENV ?? null, pip: process.env.PIP_CONSTRAINT ?? null, path: process.env.PATH ?? '', ...more }) + '\\n');",
  ];
  put('step.mjs', [...head,
    'const [name, ...options] = process.argv.slice(2);',
    'const venv = process.env.VIRTUAL_ENV;',
    'const marker = venv ? path.join(venv, "marker.txt") : null;',
    'const counter = path.join(STATE, name.replace(/[^a-z0-9]/gi, "_"));',
    'const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;',
    'fs.writeFileSync(counter, String(calls + 1));',
    'record(name, { stale: marker ? fs.existsSync(marker) : null, calls });',
    'if (marker && fs.existsSync(venv)) fs.writeFileSync(marker, "x");',
    'const install = (wheel) => { const r = spawnSync(UV, ["pip", "install", "--offline", wheel], { stdio: "inherit" }); if (r.status !== 0) process.exit(r.status ?? 1); };',
    'const planted = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "planted.txt"), "x"); };',
    'for (const option of options) {',
    '  const [key, ...rest] = option.split("=");',
    '  const value = rest.join("=");',
    '  if (key === "fail-first" && calls === 0) process.exit(1);',
    '  if (key === "fail-always") process.exit(1);',
    '  if (key === "install") install(value);',
    '  if (key === "install-on-call") { const [n, wheel] = value.split("@"); if (calls === Number(n)) install(wheel); }',
    '  if (key === "plant" && value === "own") { planted(venv); planted(`${venv}-boot`); }',
    '  if (key === "plant" && value.startsWith("sibling:")) planted(path.join(path.dirname(venv), value.slice(8)));',
    '  if (key === "plant" && value.startsWith("cell:")) planted(path.resolve(venv, "..", "..", "..", "..", value.slice(5), "seed1", "venv", "0"));',
    '}',
  ]);
  put('checks/lesson.mjs', [...head,
    'const venv = process.env.VIRTUAL_ENV;',
    'record("check", { note: venv ? fs.existsSync(path.join(venv, "note.txt")) : null });',
    'if (!fs.existsSync("lesson.txt")) process.exit(3);',
    'process.exit(fs.readFileSync("lesson.txt", "utf8").trim() === "bad" ? 1 : 0);',
  ]);
  return {
    dir, log, checker: join(dir, 'checks', 'lesson.mjs'),
    cmd: (name: string, ...options: string[]) => `"${process.execPath}" "${join(dir, 'step.mjs')}" ${name}${options.map((o) => ` "${o}"`).join('')}`,
    events: (): Ev[] => jsonl<Ev>(log),
    /** The fake agent behind a wrapper that logs each spawn's venv names before running it. */
    agent: (k: Knobs) => {
      put('probe.mjs', [...head,
        "const argv = process.argv.slice(2);",
        "record(argv.includes('--version') ? 'version' : (argv.includes('--resume') ? 'resume' : (argv.includes('--settings') ? 'session' : 'warm-up')));",
        `const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_AGENT)}, '--fake-knobs', ${JSON.stringify(k.file)}, ...argv], { stdio: 'inherit', env: process.env });`,
        'process.exit(r.status ?? 1);',
      ]);
      return `"${process.execPath}" "${join(dir, 'probe.mjs')}"`;
    },
  };
}

type Tools = ReturnType<typeof toolbox>;
interface Extra { venv?: { poetryDir: string; pipConstraint: string }; limitWaitMs?: number; warmup?: boolean; passEnv?: string[]; log?: (m: string) => void; removeTree?: (p: string) => void }

/** A temp poetry folder and a constraint file, as --venv takes them. */
function venvOpts() {
  const dir = tmp('r4-venv-poetry-');
  mkdirSync(join(dir, 'Scripts'));
  const pipConstraint = join(dir, 'constraints.txt');
  writeFileSync(pipConstraint, 'poetry==2.5.1\n');
  return { poetryDir: dir, pipConstraint };
}

/** runAll under r4 with a stub upstream, so a request from the fake never leaves the machine. */
async function r4run(s: ReturnType<typeof abRun.validateTasks>, arms: string[], out: string, agent: string, extra: Extra = {}) {
  mkdirSync(out, { recursive: true });
  const stub = await startStubUpstream(join(out, 'stub.jsonl'));
  try {
    return await abRun.runAll({
      spec: s, arms, seeds: 1, outDir: out, model: null, claudeBin: agent, settleMs: 0, warmup: false, log: () => {}, passEnv: fixtureEnv(), design: DESIGNS.r4, effort: 'medium', upstream: stub.url, hippoBuild: BUILD, ...extra,
    });
  } finally {
    await stub.close();
  }
}

const withImports = (t: TaskDef, venvImports: string[]) => ({ ...t, venvImports });
const lessonF1 = (tools: Tools) => family('f1', [lesson('f1-l1', 'Write the lesson file', { check: { script: tools.checker, args: [] } })]);
const rawOf = (out: string, id: string, suffix: string) => join(out, 'raw', 'seqF', 'S1', 'seed1', `${id}${suffix}`);
const venvAt = (out: string, pos: number) => join(runRoot(out, 'S1'), 'venv', String(pos));
const pathHead = (e: Ev) => e.path.split(delimiter).slice(0, 2);
const namesOf = (e: { envKeys: string[] }) => e.envKeys.map((k) => k.toUpperCase());

/** A spec of one sequence on `repo`: the families' sequence repo is the fixture repo. */
function build(tools: Tools, repo: FixtureRepo, tasks: TaskDef[], families = [lessonF1(tools)]) {
  const raw = { families, sequences: [{ id: 'seqF', cluster: 'c', repo: repo.repo, fixedOrder: true, tasks }] };
  return { raw, spec: abRun.validateTasks(structuredClone(raw), tools.dir) };
}

describe('a run with no --venv under round 4', () => {
  it('has neither name in any setup, check or session, and no venv folder, venv file or venvResumed key, whatever the launcher env holds', async () => {
    const { out } = isolate('r4-novenv');
    const tools = toolbox(null);
    const r = makeRepo();
    const k = knobs();
    const { spec } = build(tools, r, [
      task(r, 'p1', 'look around only', { setup: tools.cmd('setup:p1'), test: `${tools.cmd('test:p1')} && node test.js` }),
      task(r, 'p2', 'look around only', { setup: tools.cmd('setup:p2'), test: `${tools.cmd('test:p2')} && node test.js` }),
    ], []);
    process.env.VIRTUAL_ENV = 'C:/launcher/venv';
    process.env.PIP_CONSTRAINT = 'C:/launcher/constraints.txt';
    await r4run(spec, ['S1'], out, tools.agent(k));
    const events = tools.events();
    expect(events.map((e) => e.step)).toEqual(['version', 'setup:p1', 'session', 'test:p1', 'setup:p2', 'session', 'test:p2']);
    for (const e of events) expect([e.venv, e.pip], e.step).toEqual([null, null]);
    expect(existsSync(join(runRoot(out, 'S1'), 'venv'))).toBe(false);
    expect(existsSync(rawOf(out, 'p1', '.venv.txt'))).toBe(false);
    const records = wire(out);
    expect(records).toHaveLength(2);
    for (const x of records) {
      expect(namesOf(x)).not.toContain('VIRTUAL_ENV');
      expect(namesOf(x)).not.toContain('PIP_CONSTRAINT');
      expect(x).not.toHaveProperty('venvResumed');
    }
  }, 120_000);
});

// ---- Python 3.12 and uv 0.10.9 ----

const python = spawnSync('python', ['--version'], { encoding: 'utf8' });
const HAVE_PYTHON = python.status === 0 && `${python.stdout}${python.stderr}`.startsWith('Python 3.12.');
const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['uv'], { encoding: 'utf8' });
const UV = found.status === 0 ? (found.stdout.split(/\r?\n/)[0] ?? '').trim() || null : null;
const HAVE_UV = UV !== null && /^uv 0\.10\.9\b/.test(spawnSync(UV, ['--version'], { encoding: 'utf8' }).stdout);
const REAL = HAVE_PYTHON && HAVE_UV;
const Q255 = 'C:/z0-runs/r4/tasks/q255';
const Q255_NET = REAL && process.env.Z0_VENV_NET === '1' && existsSync(join(Q255, 'tasks-run.json'));

/** The smallest wheel uv 0.10.9 installs offline: the module, METADATA, WHEEL and an empty RECORD (four files; two or three fail). */
function wheel(name: string): string {
  const file = join(tmp('r4-venv-wheel-'), `${name}-1.0-py3-none-any.whl`);
  const code = [
    'import sys, zipfile',
    'name, out = sys.argv[1], sys.argv[2]',
    'meta = "Metadata-Version: 2.1\\nName: %s\\nVersion: 1.0\\n" % name',
    'tag = "Wheel-Version: 1.0\\nGenerator: z0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"',
    'with zipfile.ZipFile(out, "w") as z:',
    '    z.writestr(name + ".py", "X = 1\\n")',
    '    z.writestr(name + "-1.0.dist-info/METADATA", meta)',
    '    z.writestr(name + "-1.0.dist-info/WHEEL", tag)',
    '    z.writestr(name + "-1.0.dist-info/RECORD", "")',
  ].join('\n');
  const r = spawnSync('python', ['-I', '-c', code, name, file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`the wheel script failed: ${r.stderr}`);
  return file;
}

const LEAD = 'look around only';

describe.skipIf(!REAL)('Venv row: real Python 3.12 and uv 0.10.9 (skipped here when either is missing)', () => {
  it('gives each task its own VIRTUAL_ENV and PIP_CONSTRAINT in setup, session, resume, checks and the test, and none to the version probe', async () => {
    const { out } = isolate('r4-venv-env');
    const tools = toolbox(UV);
    const r = makeRepo();
    const venv = venvOpts();
    const step = (id: string) => ({ setup: tools.cmd(`setup:${id}`), test: `${tools.cmd(`test:${id}`)} && node test.js` });
    const { spec } = build(tools, r, [
      teach(r, 't1', 'f1-l1', 'LESSON_BAD', step('t1')), task(r, 'n1', LEAD, step('n1')), task(r, 'n2', LEAD, step('n2')),
      apply(r, 'a1', 'f1-l1', 'LESSON_BAD', step('a1')), apply(r, 'a2', 'f1-l1', 'LESSON_BAD', step('a2')),
    ]);
    await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv });
    const events = tools.events();
    const expected: [string, number | null][] = [
      ['version', null],
      ['setup:t1', 0], ['session', 0], ['check', 0], ['resume', 0], ['check', 0], ['test:t1', 0],
      ['setup:n1', 1], ['session', 1], ['test:n1', 1],
      ['setup:n2', 2], ['session', 2], ['test:n2', 2],
      ['setup:a1', 3], ['session', 3], ['check', 3], ['resume', 3], ['check', 3], ['test:a1', 3],
      ['setup:a2', 4], ['session', 4], ['check', 4], ['resume', 4], ['check', 4], ['test:a2', 4],
    ];
    expect(events.map((e) => e.step)).toEqual(expected.map(([s]) => s));
    for (const [i, e] of events.entries()) {
      const pos = expected[i]![1];
      if (pos === null) {
        expect([e.venv, e.pip], e.step).toEqual([null, null]);
        continue;
      }
      expect(e.venv, `${e.step} ${i}`).toBe(venvAt(out, pos));
      expect(e.pip, `${e.step} ${i}`).toBe(venv.pipConstraint);
      expect(pathHead(e), `${e.step} ${i}`).toEqual([join(venvAt(out, pos), 'Scripts'), join(venv.poetryDir, 'Scripts')]);
    }
    expect(new Set(events.map((e) => e.venv).filter(Boolean)).size).toBe(5);
    const records = wire(out);
    expect(records.map((x) => [x.taskId, x.invalid, x.venvResumed])).toEqual([['t1', null, false], ['n1', null, false], ['n2', null, false], ['a1', null, false], ['a2', null, false]]);
    for (const x of records) expect(namesOf(x)).toEqual(expect.arrayContaining(['VIRTUAL_ENV', 'PIP_CONSTRAINT']));
    for (const pos of [0, 1, 2, 3, 4]) for (const dir of [venvAt(out, pos), `${venvAt(out, pos)}-boot`]) expect(existsSync(dir), dir).toBe(false);
  }, 240_000);

  it('installs into the task\'s own venv: the .venv.txt format, the imports, and a package added after the session shows only in packages_end', async () => {
    const { out } = isolate('r4-venv-wheel');
    const tools = toolbox(UV);
    const r = makeRepo();
    const [probe, late] = [wheel('z0venvprobe'), wheel('z0venvlate')];
    const imports = ['z0venvprobe', 'z0venvlate'];
    const { spec } = build(tools, r, [
      withImports(task(r, 'p1', LEAD, { setup: tools.cmd('setup:p1', `install=${probe}`), test: `${tools.cmd('test:p1', `install=${late}`)} && node test.js` }), imports),
      withImports(task(r, 'p2', LEAD, { setup: tools.cmd('setup:p2'), test: 'node test.js' }), imports),
    ], []);
    await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv: venvOpts() });
    const read = (id: string) => readFileSync(rawOf(out, id, '.venv.txt'), 'utf8');
    for (const id of ['p1', 'p2']) {
      const text = read(id);
      expect(text, id).not.toContain('\r');
      expect(text.endsWith('\n'), id).toBe(true);
    }
    const lines = (id: string) => Object.fromEntries(read(id).trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const keys = (id: string) => read(id).trim().split('\n').map((l) => l.slice(0, l.indexOf('=')));
    const [one, two] = [lines('p1'), lines('p2')];
    expect(keys('p1')).toEqual(['prefix', 'packages', 'setup_ms', 'import_z0venvprobe', 'import_z0venvlate', 'packages_end']);
    expect(keys('p2')).toEqual(['prefix', 'packages', 'setup_ms', 'import_z0venvprobe', 'import_z0venvlate', 'packages_end']);
    for (const [id, l] of [['p1', one], ['p2', two]] as const) {
      expect(l.prefix, id).toBeTruthy();
      expect(norm(l.prefix!), id).toBe(norm(venvAt(out, id === 'p1' ? 0 : 1)));
      expect(l.setup_ms, id).toMatch(/^\d+$/);
      console.log(`VENV SETUP MS ${id} ${l.setup_ms}`);
    }
    expect(one.prefix).not.toBe(two.prefix);
    const names = (v: string | undefined) => (v ? v.split(',') : []);
    expect(names(one.packages)).toContain('z0venvprobe');
    expect(names(one.packages)).not.toContain('z0venvlate');
    expect(names(one.packages_end)).toEqual(expect.arrayContaining(['z0venvprobe', 'z0venvlate']));
    for (const v of [one.packages, one.packages_end, two.packages, two.packages_end]) expect(names(v)).toEqual(sorted(names(v)));
    expect([one.import_z0venvprobe, one.import_z0venvlate]).toEqual(['ok', 'fail']);
    expect(names(two.packages)).not.toContain('z0venvprobe');
    expect(names(two.packages_end)).not.toContain('z0venvprobe');
    expect([two.import_z0venvprobe, two.import_z0venvlate]).toEqual(['fail', 'fail']);
  }, 240_000);

  it('probes the task\'s own interpreter: a python.cmd and a module in the work tree stand in for neither the venv\'s python nor its imports', async () => {
    const { out } = isolate('r4-venv-shadow');
    const tools = toolbox(UV);
    const r = makeRepo({ 'python.cmd': '@echo FAKE-PYTHON-FROM-THE-WORK-TREE\r\n', 'z0shadow.py': 'X = 1\n' });
    const { spec } = build(tools, r, [withImports(task(r, 's1', LEAD, { setup: tools.cmd('setup:s1') }), ['z0shadow']), task(r, 's2', LEAD)], []);
    await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv: venvOpts() });
    const text = readFileSync(rawOf(out, 's1', '.venv.txt'), 'utf8');
    const line = (key: string) => text.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
    expect(norm(line('prefix') ?? ''), text).toBe(norm(venvAt(out, 0)));
    expect(line('import_z0shadow'), text).toBe('fail');
    expect(line('packages')?.split(',')).toContain('pip');
    expect(line('packages_end')?.split(',')).toContain('pip');
  }, 240_000);

  it('a setup retry and a usage-limit reset each start from an empty venv, and the venv file is rewritten after the reset', async () => {
    const { out } = isolate('r4-venv-empty');
    const tools = toolbox(UV);
    const r = makeRepo();
    const probe = wheel('z0venvprobe');
    process.env.FAKE_CLAUDE_LIMIT_ONCE = join(tmp('r4-venv-limit-'), 'once');
    const { spec } = build(tools, r, [
      task(r, 'r1', LEAD, { setup: tools.cmd('setup:r1', 'fail-first') }),
      withImports(task(r, 'r2', 'LIMIT', { setup: tools.cmd('setup:r2', `install-on-call=1@${probe}`) }), ['z0venvprobe']),
    ], []);
    await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv: venvOpts(), limitWaitMs: 0 });
    const stale = (id: string) => tools.events().filter((e) => e.step === `setup:${id}`).map((e) => [e.calls, e.stale]);
    expect(stale('r1')).toEqual([[0, false], [1, false]]);
    expect(stale('r2')).toEqual([[0, false], [1, false]]);
    const records = readRecords(out);
    expect(records.map((x) => [x.taskId, x.invalid, x.limitRetries])).toEqual([['r1', null, 0], ['r2', null, 1]]);
    // The reset's own setup installed the wheel, so only a rewrite after the reset shows it.
    const rewritten = readFileSync(rawOf(out, 'r2', '.venv.txt'), 'utf8');
    expect(rewritten).toContain('import_z0venvprobe=ok');
    // A file the reset appended to instead of rewriting would carry the first try's lines too.
    expect(rewritten.split('\n').filter((l) => l.startsWith('prefix=') || l.startsWith('packages='))).toHaveLength(2);
    expect(existsSync(rawOf(out, 'r1', '.setup-try1.txt'))).toBe(true);
  }, 240_000);

  it('a removeTree that throws is logged and written to <task>.venv-remove.txt, and the next task still runs', async () => {
    const { out } = isolate('r4-venv-rm');
    const tools = toolbox(UV);
    const r = makeRepo();
    const logs: string[] = [];
    const { spec } = build(tools, r, [task(r, 'p1', LEAD, { setup: tools.cmd('setup:p1') }), task(r, 'p2', LEAD, { setup: tools.cmd('setup:p2') })], []);
    await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv: venvOpts(), log: (m: string) => logs.push(m), removeTree: (p: string) => { throw new Error(`busy ${basename(p)}`); } });
    expect(readRecords(out).map((x) => [x.taskId, x.invalid])).toEqual([['p1', null], ['p2', null]]);
    for (const [id, pos] of [['p1', 0], ['p2', 1]] as const) {
      const text = readFileSync(rawOf(out, id, '.venv-remove.txt'), 'utf8');
      expect(text).toContain(`busy ${pos}`);
      expect(text).toContain(`busy ${pos}-boot`);
    }
    expect(logs.filter((m) => /venv/.test(m) && /busy/.test(m)).length).toBeGreaterThanOrEqual(2);
    expect(existsSync(rawOf(out, 'p2', '.venv.txt'))).toBe(true);
  }, 240_000);

  it('a cut-off resume gives venvResumed true on its own record only, and leaves the venv as it was', async () => {
    const { out } = isolate('r4-venv-cut');
    const tools = toolbox(UV);
    const r = makeRepo();
    const note = `APPEND:{RUN}/venv/0/note.txt:kept`;
    const { spec } = build(tools, r, [
      teach(r, 't1', 'f1-l1', `CUT_ON_RESUME\nLESSON_BAD\n${note}`, { setup: tools.cmd('setup:t1') }), task(r, 'n1', LEAD, { setup: tools.cmd('setup:n1') }), task(r, 'n2', LEAD, { setup: tools.cmd('setup:n2') }),
      apply(r, 'a1', 'f1-l1', LEAD, { setup: tools.cmd('setup:a1') }), apply(r, 'a2', 'f1-l1', LEAD, { setup: tools.cmd('setup:a2') }),
    ]);
    await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv: venvOpts(), limitWaitMs: 0 });
    const records = wire(out);
    expect(records.map((x) => [x.taskId, x.venvResumed])).toEqual([['t1', true], ['n1', false], ['n2', false], ['a1', false], ['a2', false]]);
    expect(records[0]).toMatchObject({ invalid: null, limitRetries: 1 });
    // Both checks of t1 ran after the cut-off reset, and the file the session wrote into the venv was still there.
    expect(tools.events().filter((e) => e.step === 'check').slice(0, 2).map((e) => e.note)).toEqual([true, true]);
    expect(tools.events().filter((e) => e.step === 'setup:t1')).toHaveLength(1);
  }, 360_000);

  it('a setup that fails twice leaves no venv or -boot, and the next task starts from the launch PATH with its own VIRTUAL_ENV', async () => {
    const { out } = isolate('r4-venv-bad');
    const tools = toolbox(UV);
    const r = makeRepo();
    const { spec } = build(tools, r, [
      task(r, 'g1', LEAD, { setup: tools.cmd('setup:g1') }), task(r, 'g2', LEAD, { setup: tools.cmd('setup:g2', 'fail-always') }), task(r, 'g3', LEAD, { setup: tools.cmd('setup:g3') }),
    ], []);
    await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv: venvOpts() });
    expect(readRecords(out).map((x) => [x.taskId, x.invalid])).toEqual([['g1', null], ['g2', 'setup'], ['g3', null]]);
    for (const dir of [venvAt(out, 1), `${venvAt(out, 1)}-boot`]) expect(existsSync(dir), dir).toBe(false);
    expect(existsSync(rawOf(out, 'g2', '.venv.txt'))).toBe(false);
    expect(tools.events().filter((e) => e.step === 'setup:g2')).toHaveLength(2);
    const setup = (id: string) => tools.events().find((e) => e.step === `setup:${id}`)!;
    const tail = (e: Ev) => e.path.split(delimiter).slice(2).join(delimiter);
    expect(setup('g3').venv).toBe(venvAt(out, 2));
    expect(tail(setup('g3'))).toBe(tail(setup('g1')));
    expect(setup('g3').path).not.toContain(join(venvAt(out, 1), 'Scripts'));
  }, 240_000);

  it('a task whose staging throws (the cached repo is gone, so the checkout fails) leaves no venv, and run.env is the launch env again', async () => {
    const { out } = isolate('r4-venv-throw');
    const tools = toolbox(UV);
    const r = makeRepo();
    const removed: string[] = [];
    const { spec } = build(tools, r, [task(r, 'p1', LEAD, { setup: tools.cmd('setup:p1') }), task(r, 'p2', LEAD)], []);
    const venv = venvOpts();
    mkdirSync(out, { recursive: true });
    const stub = await startStubUpstream(join(out, 'stub.jsonl'));
    try {
      const ctx = await openContext({
        spec, arms: ['S1'], outDir: out, model: null, claudeBin: tools.agent(knobs()), settleMs: 0, warmup: false, log: () => {}, passEnv: [], design: DESIGNS.r4, effort: 'medium', upstream: stub.url, hippoBuild: BUILD, venv,
        removeTree: (p: string) => { removed.push(p); rmSync(p, { recursive: true, force: true }); },
      });
      const first = abRun.planRuns(spec, ['S1'], () => 1, 1, 1)[0]!;
      const run = { ...startRun(ctx, first.sequence, 'S1', 1, first.sequence.id), taught: [] };
      rmSync(run.cached, { recursive: true, force: true });
      await expect(runTask(ctx, run, { ...first, order: 0, driver: driverOf(first.role) })).rejects.toThrow();
      expect(removed).toEqual([venvAt(out, 0), `${venvAt(out, 0)}-boot`]);
      for (const dir of [venvAt(out, 0), `${venvAt(out, 0)}-boot`]) expect(existsSync(dir), dir).toBe(false);
      expect(run.env).toBe(run.launchEnv);
      for (const name of TASK_KEYS) expect(Object.keys(run.env).map((k: string) => k.toUpperCase())).not.toContain(name);
    } finally {
      await stub.close();
    }
  }, 240_000);

  it('G1 treats the task\'s own venv and -boot as its work, another task\'s venv as outside-work, and another cell\'s venv as other-run', async () => {
    const { out } = isolate('r4-venv-g1');
    const tools = toolbox(UV);
    const r = makeRepo();
    const own = ['READ:{RUN}/venv/0/planted.txt', 'READ:{RUN}/venv/0-boot/planted.txt'].join('\n');
    const { spec } = build(tools, r, [
      task(r, 'g0', own, { setup: tools.cmd('setup:g0', 'plant=own') }),
      task(r, 'g1', 'READ:{RUN}/venv/0/planted.txt', { setup: tools.cmd('setup:g1', 'plant=sibling:0') }),
      task(r, 'g2', 'READ:{OUT}/runs/seqF/S0/seed1/venv/0/planted.txt', { setup: tools.cmd('setup:g2', 'plant=cell:S0') }),
    ], []);
    await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv: venvOpts() });
    const records = wire(out);
    expect(records.map((x) => [x.taskId, x.invalid, x.void, (x.voidHits ?? []).map((h) => h.class)])).toEqual([
      ['g0', null, null, []], ['g1', null, 'read', ['outside-work']], ['g2', null, 'read', ['other-run']],
    ]);
  }, 240_000);

  it('warm-ups and the version probe see neither name, and the sessions of the same run see both', async () => {
    const { out } = isolate('r4-venv-warm');
    const tools = toolbox(UV);
    const r = makeRepo();
    const { spec } = build(tools, r, [task(r, 'p1', LEAD, { setup: tools.cmd('setup:p1') }), task(r, 'p2', LEAD, { setup: tools.cmd('setup:p2') })], []);
    await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv: venvOpts(), warmup: true });
    const events = tools.events();
    expect(new Set(events.filter((e) => ['version', 'warm-up'].includes(e.step)).map((e) => e.step))).toEqual(new Set(['version', 'warm-up']));
    for (const e of events.filter((x) => ['version', 'warm-up'].includes(x.step))) expect([e.venv, e.pip], e.step).toEqual([null, null]);
    const sessions = events.filter((e) => e.step === 'session');
    expect(sessions.map((e) => e.venv)).toEqual([venvAt(out, 0), venvAt(out, 1)]);
  }, 240_000);

  describe('the regrade of a --venv run', () => {
    async function venvRun(name: string) {
      const { out } = isolate(name);
      const tools = toolbox(UV);
      const r = makeRepo();
      const venv = venvOpts();
      const { raw, spec } = build(tools, r, [
        teach(r, 't1', 'f1-l1', 'LESSON_BAD', { setup: tools.cmd('setup:t1') }), task(r, 'n1', LEAD, { setup: tools.cmd('setup:n1') }), task(r, 'n2', LEAD, { setup: tools.cmd('setup:n2') }),
        apply(r, 'a1', 'f1-l1', 'LESSON_BAD', { setup: tools.cmd('setup:a1') }), apply(r, 'a2', 'f1-l1', 'LESSON_BAD', { setup: tools.cmd('setup:a2') }),
      ]);
      await r4run(spec, ['S1'], out, tools.agent(knobs()), { venv });
      const tasks = join(tools.dir, 'tasks.json');
      writeFileSync(tasks, JSON.stringify(raw));
      return { out, tools, venv, tasks };
    }

    it('passes the env-key check, runs its setup in the scratch venv under <out>/rg, and removes the venv after', async () => {
      const c = await venvRun('r4-venv-regrade');
      const runEvents = c.tools.events().length;
      const res = await cli(['regrade', '--out', c.out, '--tasks', c.tasks, '--poetry', c.venv.poetryDir, '--pip-constraint', c.venv.pipConstraint]);
      expect(res.code, res.stderr).toBe(0);
      expect(rowsOf(c.out).map((x) => [x.taskId, x.status])).toEqual([['t1', 'done'], ['n1', 'done'], ['n2', 'done'], ['a1', 'done'], ['a2', 'done']]);
      const regraded = c.tools.events().slice(runEvents).filter((e) => e.step.startsWith('setup:'));
      const scratch = join(realpathSync.native(c.out), 'rg', 'seqF', 'S1', 'seed1', 'venv');
      expect(regraded.map((e) => [e.step, norm(e.venv ?? '')])).toEqual([['setup:t1', norm(join(scratch, '0'))], ['setup:n1', norm(join(scratch, '1'))], ['setup:n2', norm(join(scratch, '2'))], ['setup:a1', norm(join(scratch, '3'))], ['setup:a2', norm(join(scratch, '4'))]]);
      for (const e of regraded) expect(e.pip).toBe(c.venv.pipConstraint);
      for (const pos of [0, 1, 2, 3, 4]) for (const dir of [join(scratch, String(pos)), `${join(scratch, String(pos))}-boot`]) expect(existsSync(dir), dir).toBe(false);
    }, 300_000);

    it('with neither flag it stops before any cell, naming both', async () => {
      const c = await venvRun('r4-venv-regrade-none');
      const res = await cli(['regrade', '--out', c.out, '--tasks', c.tasks]);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('a round 4 record of seqF/S1/seed1 ran in a task venv; pass --poetry <dir> and --pip-constraint <file>');
      expect(rowsOf(c.out)).toEqual([]);
      const one = await cli(['regrade', '--out', c.out, '--tasks', c.tasks, '--poetry', c.venv.poetryDir]);
      expect(one.code).toBe(1);
      expect(one.stderr).toMatch(/--poetry/);
      expect(one.stderr).toMatch(/--pip-constraint/);
    }, 300_000);
  });
});

describe('a round 3 regrade with VIRTUAL_ENV in its envKeys', () => {
  it('regrades with no flags and no venv', async () => {
    const { out } = isolate('r3-venv-regrade');
    const r = makeRepo();
    const dir = tmp('r3-venv-regrade-tools-');
    const venv = tmp('r3-venv-launch-');
    const raw = { families: [family('f1', [lesson('f1-l1', 'Write the lesson file', { check: { script: join(CHECKS, 'lesson.mjs'), args: [] } })])], sequences: [{ id: 'seqF', cluster: 'c', repo: r.repo, fixedOrder: true, tasks: [teach(r, 't1', 'f1-l1', 'LESSON_OK'), plain(r, 'n1'), plain(r, 'n2'), apply(r, 'a1', 'f1-l1', 'LESSON_OK'), apply(r, 'a2', 'f1-l1', 'LESSON_OK')] }] };
    process.env.VIRTUAL_ENV = venv;
    await run(abRun.validateTasks(structuredClone(raw), CHECKS), ['A0'], out, { passEnv: ['VIRTUAL_ENV', ...fixtureEnv()] });
    const recorded = wire(out);
    for (const x of recorded) expect(namesOf(x)).toContain('VIRTUAL_ENV');
    const tasks = join(dir, 'tasks.json');
    writeFileSync(tasks, JSON.stringify(raw));
    const res = await cli(['regrade', '--out', out, '--tasks', tasks], { VIRTUAL_ENV: venv, CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(res.code, res.stderr).toBe(0);
    expect(rowsOf(out).map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
  }, 240_000);
});

describe.skipIf(!Q255_NET)('q255 in a real task venv (Z0_VENV_NET=1 only: it installs from PyPI)', () => {
  it('runs q255-f1-teach then q255-a1 in their own venvs, the boot poetry is 2.5.1, and both cells regrade to the run\'s verdicts', async () => {
    const { out } = isolate('r4-venv-q255');
    const k = knobs();
    process.env.PYTHONDONTWRITEBYTECODE = '1';
    const full = JSON.parse(readFileSync(join(Q255, 'tasks-run.json'), 'utf8'));
    const seq = full.sequences[0];
    const keep = ['q255-f1-teach', 'q255-a1'].map((id) => seq.tasks.find((t: { id: string }) => t.id === id));
    const resolved = (f: { lessons: { check: { script: string } }[] }) => ({ ...f, lessons: f.lessons.map((l) => ({ ...l, check: { ...l.check, script: resolve(Q255, l.check.script) } })) });
    const raw = { families: full.families.filter((f: { id: string }) => f.id === 'q255-f1').map(resolved), sequences: [{ ...seq, fixedOrder: true, tasks: keep }] };
    const spec = abRun.validateTasks(structuredClone(raw), Q255);
    const kept: string[] = [];
    const venv = { poetryDir: 'C:/z0-runs/r4/poetry-2.5.1', pipConstraint: 'C:/z0-runs/r4/pip-constraints.txt' };
    // Removal is deferred, so the boot venv of the first task is still there to ask.
    await r4run(spec, ['S1'], out, k.cmd, { venv, passEnv: ['PYTHONDONTWRITEBYTECODE'], removeTree: (p: string) => { kept.push(p); } });
    const records = readRecords(out);
    expect(records.map((x) => [x.taskId, x.invalid])).toEqual([['q255-f1-teach', null], ['q255-a1', null]]);
    const boot = kept.find((p) => p.endsWith(join('venv', '0-boot')))!;
    const version = spawnSync(join(boot, 'Scripts', 'poetry.exe'), ['--version'], { encoding: 'utf8' });
    expect(`${version.stdout}${version.stderr}`).toContain('2.5.1');
    for (const p of kept) rmSync(p, { recursive: true, force: true });
    const tasks = join(tmp('r4-venv-q255-tasks-'), 'tasks.json');
    writeFileSync(tasks, JSON.stringify(raw));
    const res = await cli(['regrade', '--out', out, '--tasks', tasks, '--poetry', venv.poetryDir, '--pip-constraint', venv.pipConstraint], { PYTHONDONTWRITEBYTECODE: '1' });
    expect(res.code, res.stderr).toBe(0);
    const rows = rowsOf(out);
    expect(rows.map((x) => [x.taskId, x.status])).toEqual([['q255-f1-teach', 'done'], ['q255-a1', 'done']]);
    for (const x of rows) {
      expect(x.acceptance!.flip).toBe(false);
      for (const c of x.checks) expect(c.flip).toBe(false);
    }
  }, 1_800_000);
});
