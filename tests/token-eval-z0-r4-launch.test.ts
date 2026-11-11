// Round 4 slice 2b, the launchers: s4-run.ps1 and s4-regrade.ps1 under PowerShell 5.1, against a fixture checkout, a dry root and a real-shaped root, and a stub z0-regrade.mjs.
// No session is paid: every launched run is the fake agent on a DRYRUN root, and the real root is only asked for its argv with -DryRun.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { runCli as pinsCli } from '../scripts/token-eval/z0-pins-check.mjs';
import { SONNET_MODEL } from '../scripts/token-eval/arms.mjs';
import { cleanup, makeRepo } from './fixtures/z0-harness.js';
import { PRICES_BY_MODEL } from './fixtures/z0-gen.js';

const REPO = resolve(__dirname, '..');
const LAUNCH = join(REPO, 'scripts', 'token-eval', 'r4-launch');
const RUN_PS = join(LAUNCH, 's4-run.ps1');
const REGRADE_PS = join(LAUNCH, 's4-regrade.ps1');
const POETRY = 'C:/z0-runs/r4/poetry-2.5.1';
const CLAUDE_BIN = 'C:/z0-runs/scored/bin/claude.exe';
const TOKEN_VAR = 'Z0_SUB_TOKEN';
const slash = (p: string) => p.replaceAll('\\', '/');

const ps = (command: string) => (process.platform === 'win32' ? spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' }) : null);
const HAVE_PS = ps('$PSVersionTable.PSVersion.Major')?.status === 0;
const HAVE_BOX = ['C:/eval-authors/s3x-env.ps1', `${POETRY}/Scripts/poetry.exe`, CLAUDE_BIN, 'C:/z0-runs/s7/box-check.sh', 'C:/Program Files/Git/bin/bash.exe'].every((f) => existsSync(f));
// The name only: the value is never read into this test.
const HAVE_USER_TOKEN = HAVE_PS && (ps(`if ([Environment]::GetEnvironmentVariable('${TOKEN_VAR}', 'User')) { 'set' }`)?.stdout ?? '').includes('set');

const KEYS = { npm: 'npmkey', python: 'pykey', slow: 'slowkey' };
const PINNED = 'tasks';

interface Result { code: number; lines: string[]; out: string }
interface Root { dir: string; dry: boolean }
interface World { base: string; checkout: string; dry: Root; real: Root; knobs: string; stubBox: { ok: string; bad: string } }
const world: World = { base: '', checkout: '', dry: { dir: '', dry: true }, real: { dir: '', dry: false }, knobs: '', stubBox: { ok: '', bad: '' } };

/** The script as `powershell -NoProfile -ExecutionPolicy Bypass -File`, with the test's own env: no stray token, no ancestor stop, no bytecode. */
function psArgs(script: string, args: string[]) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args];
}
function launcherEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  for (const k of ['Z0_ANCESTOR_STOP', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  return env;
}
// The launcher gets the test's own folder as cwd: a launched runner leaves a Microsoft/Windows/PowerShell cache in its cwd, and that must not be the repo.
function call(script: string, args: string[]): Result {
  const r = spawnSync('powershell', psArgs(script, args), { encoding: 'utf8', cwd: world.base, env: launcherEnv(), timeout: 240_000, maxBuffer: 1 << 26 });
  const out = `${r.stdout ?? ''}`;
  return { code: r.status ?? -1, lines: out.split(/\r?\n/).filter(Boolean), out };
}
const run = (args: string[]) => call(RUN_PS, args);
const regrade = (args: string[]) => call(REGRADE_PS, args);

/** The launcher run asynchronously: `onFirst` gets the first stdout line while the launcher still lives. */
function launchLive(script: string, args: string[], onFirst: (line: string) => void): Promise<Result> {
  return new Promise((resolveDone, reject) => {
    const child = spawn('powershell', psArgs(script, args), { cwd: world.base, env: launcherEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let first = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const at = out.indexOf('\n');
      if (at >= 0 && !first) {
        first = true;
        try {
          onFirst(out.slice(0, at).trim());
        } catch (err) {
          reject(err);
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => resolveDone({ code: code ?? -1, lines: out.split(/\r?\n/).filter(Boolean), out }));
  });
}

const commandLineOf = (pid: number) => (ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`)?.stdout ?? '').trim();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const argvOf = (r: Result): string[] => {
  const line = r.lines.find((l) => l.startsWith('ab-run argv '));
  if (!line) throw new Error(`no "ab-run argv" line in: ${r.out}`);
  return JSON.parse(line.slice('ab-run argv '.length));
};
const valueOf = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const countOf = (argv: string[], name: string) => argv.filter((a) => a === name).length;

interface KnobsOver { token?: string; warmupFail?: string[] }
function knobsFile(dir: string, over: KnobsOver = {}) {
  const prices = join(dir, 'prices.json');
  writeFileSync(prices, JSON.stringify(PRICES_BY_MODEL));
  const usage = { input: 1000, output: 2000, cacheRead: 50_000, cacheWrite: 4000 };
  const file = join(dir, `knobs-${Object.keys(over).join('-') || 'plain'}.json`);
  writeFileSync(file, JSON.stringify({
    schema: 'z0-fake-knobs/1', calls: join(dir, 'calls.jsonl'), prices, version: '9.9.9', usage: { S1: usage }, effortScale: { low: 0.5, medium: 1, high: 2 },
    outcome: { S1: { lesson: 0.5, solve: 0.5 } }, leaks: [], offPin: [], fail: [], warmupFail: [], ...over,
  }));
  return slash(file);
}

/** A tasks file of one sequence of two plain tasks on the fixture repo; the slow key's first setup waits, so its runner outlives a few queries. */
function tasksFile(repo: { repo: string; base: string; fix: string }, slow: boolean) {
  const t = (id: string, setup?: string) => {
    const plain = { id, kind: 'no-lesson', baseRef: repo.base, fixRef: repo.fix, prompt: 'look around only', testFiles: ['test.js'], test: 'node test.js' };
    return setup === undefined ? plain : { ...plain, setup };
  };
  const wait = `"${process.execPath}" -e "setTimeout(function(){},6000)"`;
  return JSON.stringify({ sequences: [{ id: 'seqL', cluster: 'c', repo: repo.repo, fixedOrder: true, tasks: [t('p1', slow ? wait : undefined), t('p2')] }] });
}

function makeRoot(base: string, name: string, dry: boolean, repo: { repo: string; base: string; fix: string }, checkout: string): Root {
  const dir = `${base}/${name}`;
  for (const [key, slow] of [[KEYS.npm, false], [KEYS.python, false], [KEYS.slow, true]] as const) {
    for (const folder of ['tasks', 'pilot-tasks']) {
      mkdirSync(`${dir}/${folder}/${key}`, { recursive: true });
      writeFileSync(`${dir}/${folder}/${key}/tasks-run.json`, tasksFile(repo, slow));
    }
  }
  writeFileSync(`${dir}/pip-constraints.txt`, 'poetry==2.5.1\n');
  if (dry) writeFileSync(`${dir}/DRYRUN`, '');
  writeFileSync(`${dir}/pin-roles.txt`, `${PINNED}=${dir}/tasks/${KEYS.npm}/tasks-run.json\n`);
  const written = pinsCli(['--write', `${dir}/pins-r4.json`, '--checkout', checkout, '--roles', `${dir}/pin-roles.txt`, '--poetry', POETRY,
    '--set', 'effort=medium', '--set', 'claudeVersion=9.9.9', '--set', `modelSonnet=${SONNET_MODEL}`], base);
  if (written.code !== 0) throw new Error(`pins write failed: ${written.stderr}`);
  return { dir, dry };
}

const STUB_REGRADE = [
  "import * as fs from 'node:fs';",
  'const argv = process.argv.slice(1);',
  "const dirs = (process.env.PATH ?? '').split(';');",
  "fs.appendFileSync('stub-calls.jsonl', JSON.stringify({ argv, cwd: process.cwd().replaceAll('\\\\', '/'), placeholder: process.env.CLAUDE_CODE_OAUTH_TOKEN === 'placeholder-regrade-runs-no-session', venv: process.env.VIRTUAL_ENV ?? null, venvOnPath: dirs.some((d) => /[\\\\/]venv[\\\\/]Scripts$/i.test(d)) }) + '\\n');",
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);',
  "process.exit(fs.existsSync('stub-exit.txt') ? Number(fs.readFileSync('stub-exit.txt', 'utf8')) : 0);",
].join('\n');

beforeAll(() => {
  if (!(HAVE_PS && HAVE_BOX)) return;
  mkdirSync('C:/z0-launch-tests', { recursive: true });
  const base = slash(mkdtempSync('C:/z0-launch-tests/launch-'));
  world.base = base;
  // The pins check and the runner both refuse a dirty tree, so the checkout is a clean git repository; dist/ is ignored, as in the repository.
  const checkout = `${base}/checkout`;
  mkdirSync(checkout);
  for (const folder of ['scripts', 'bin', 'dist']) cpSync(join(REPO, folder), join(checkout, folder), { recursive: true });
  mkdirSync(join(checkout, 'tests'));
  cpSync(join(REPO, 'tests', 'fixtures'), join(checkout, 'tests', 'fixtures'), { recursive: true });
  cpSync(join(REPO, 'package.json'), join(checkout, 'package.json'));
  writeFileSync(join(checkout, '.gitignore'), 'dist/\n');
  writeFileSync(join(checkout, 'scripts', 'token-eval', 'z0-regrade.mjs'), `${STUB_REGRADE}\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-qm', 'fixture checkout');
  world.checkout = checkout;
  const repo = makeRepo();
  world.dry = makeRoot(base, 'dry', true, repo, checkout);
  world.real = makeRoot(base, 'real', false, repo, checkout);
  mkdirSync(`${base}/misc`);
  world.knobs = knobsFile(`${base}/misc`);
  writeFileSync(`${base}/misc/ok.sh`, 'exit 0\n');
  writeFileSync(`${base}/misc/bad.sh`, 'echo box stub says no\nexit 1\n');
  world.stubBox = { ok: `${base}/misc/ok.sh`, bad: `${base}/misc/bad.sh` };
}, 180_000);

afterAll(() => {
  cleanup();
  // Only the folder this test made.
  if (world.base?.startsWith('C:/z0-launch-tests/launch-')) rmSync(world.base, { recursive: true, force: true, maxRetries: 5 });
});

/** The arguments every s4-run call takes, on the dry root unless `root` says otherwise. */
function args(over: { root?: Root; key?: string; batch?: string; folder?: string; toolchain?: string; more?: string[]; fake?: boolean; box?: boolean } = {}): string[] {
  const root = over.root ?? world.dry;
  const key = over.key ?? KEYS.npm;
  const batch = over.batch ?? 'smoke';
  const folder = over.folder ?? `${root.dir}/smoke/w1`;
  return [
    '-Checkout', world.checkout, '-Root', root.dir, '-Batch', batch, '-Key', key, '-Arms', 'S1', '-Toolchain', over.toolchain ?? 'npm', '-Folder', folder,
    ...(root.dry && over.fake !== false ? ['-FakeAgent', world.knobs] : []), ...(root.dry && over.box !== false ? ['-BoxCheck', world.stubBox.ok] : []), ...(over.more ?? []),
  ];
}
const untouched = (folder: string) => ['run.log', 'run.err', 'run/exit.txt'].every((f) => !existsSync(`${folder}/${f}`)) && !existsSync(`${dirname(folder)}/pids.txt`);

describe.skipIf(!(HAVE_PS && HAVE_BOX))('the launchers: needs win32, PowerShell 5.1 and this box\'s z0 tools (s3x-env.ps1, poetry-2.5.1, claude.exe, box-check.sh)', () => {
  it('-DryRun on a python key prints the argv: the venv flags and poetry once, no --model, no VIRTUAL_ENV in --pass-env, the fake agent and its placeholder token', () => {
    const r = run(args({ key: KEYS.python, toolchain: 'python', more: ['-MaxPosition', '1', '-DryRun'] }));
    expect(r.code, r.out).toBe(0);
    const folder = `${world.dry.dir}/smoke/w1`;
    expect(argvOf(r)).toEqual([
      `${world.checkout}/scripts/token-eval/ab-run.mjs`, '--tasks', `${world.dry.dir}/pilot-tasks/${KEYS.python}/tasks-run.json`, '--out', `${folder}/run`, '--design', 'r4', '--effort', 'medium',
      '--pins', `${world.dry.dir}/pins-r4.json`, '--arms', 'S1', '--max-position', '1',
      '--pass-env', 'CI', '--pass-env', 'PYTHONIOENCODING', '--pass-env', 'PYTHONUTF8',
      '--venv', '--poetry', POETRY, '--pip-constraint', `${world.dry.dir}/pip-constraints.txt`, '--fake-agent', world.knobs,
    ]);
    expect(r.lines.at(-1)).toBe('token fake-tok-placeholder');
    expect(r.lines).toHaveLength(2);
    expect(untouched(folder)).toBe(true);
  }, 120_000);

  it('-DryRun on an npm key has no venv flags, only CI to pass, and the knobs file\'s own fake token', () => {
    const own = knobsFile(`${world.base}/misc`, { token: 'fake-tok-own' });
    const r = run(args({ more: ['-DryRun'] }).map((a) => (a === world.knobs ? own : a)));
    expect(r.code, r.out).toBe(0);
    const argv = argvOf(r);
    for (const flag of ['--venv', '--poetry', '--pip-constraint', '--model', '--claude-bin']) expect(argv, flag).not.toContain(flag);
    expect(argv.filter((a, i) => argv[i - 1] === '--pass-env')).toEqual(['CI']);
    expect(valueOf(argv, '--fake-agent')).toBe(own);
    expect(r.lines.at(-1)).toBe('token fake-tok-own');
  }, 120_000);

  it('passes the seed flags that were given, in the runner\'s order', () => {
    const r = run(args({ batch: '1', folder: `${world.dry.dir}/batch1/${KEYS.npm}-w1`, more: ['-Seeds', '2', '-SeedRule', `${world.base}/rule.json`, '-MaxSeed', '5', '-MaxPosition', '3', '-DryRun'] }));
    expect(r.code, r.out).toBe(0);
    const argv = argvOf(r);
    expect(valueOf(argv, '--tasks')).toBe(`${world.dry.dir}/tasks/${KEYS.npm}/tasks-run.json`);
    expect(argv.slice(argv.indexOf('--arms'), argv.indexOf('--pass-env'))).toEqual(['--arms', 'S1', '--seeds', '2', '--seed-rule', `${world.base}/rule.json`, '--max-seed', '5', '--max-position', '3']);
  }, 120_000);

  it('-Effort low and high take their own pins file, and the effort batch names effort/<E>-p<n>', () => {
    for (const effort of ['low', 'high']) {
      const r = run(args({ batch: 'effort', folder: `${world.dry.dir}/effort/${effort}-p2`, more: ['-Effort', effort, '-Attempt', '2', '-DryRun'] }));
      expect(r.code, r.out).toBe(0);
      const argv = argvOf(r);
      expect([valueOf(argv, '--effort'), valueOf(argv, '--pins')], effort).toEqual([effort, `${world.dry.dir}/pins-r4-effort-${effort}.json`]);
      expect(valueOf(argv, '--tasks')).toBe(`${world.dry.dir}/pilot-tasks/${KEYS.npm}/tasks-run.json`);
    }
    const medium = run(args({ batch: 'effort', folder: `${world.dry.dir}/effort/medium-p1`, more: ['-Effort', 'medium', '-DryRun'] }));
    expect(medium.code).toBe(1);
    expect(medium.out).toMatch(/effort batch/);
  }, 180_000);

  it('names the folder by the layout: pilot, batches, a leak rerun and a retry; a different -Folder exits 1 naming both', () => {
    const folderOf = (batch: string, more: string[], folder: string) => run(args({ batch, folder, more: [...more, '-DryRun'] }));
    const k = KEYS.npm;
    const d = world.dry.dir;
    const good: [string, string[], string][] = [
      ['pilot', ['-Attempt', '2'], `${d}/pilot/${k}-p2`], ['pilot', ['-Retry', '2'], `${d}/pilot/${k}-p1-a2`], ['pilot', ['-Attempt', '3', '-Retry', '3'], `${d}/pilot/${k}-p3-a3`],
      ['2', [], `${d}/batch2/${k}-w1`], ['raise', [], `${d}/raise/${k}-w2`], ['1', ['-OnlySeed', '2'], `${d}/batch1/${k}-e2`], ['raise', ['-OnlySeed', '5', '-Retry', '2'], `${d}/raise/${k}-e5-a2`],
      ['1', ['-Retry', '2'], `${d}/batch1/${k}-w1-a2`],
    ];
    for (const [batch, more, folder] of good) {
      const r = folderOf(batch, more, folder);
      expect(r.code, `${batch} ${more.join(' ')}: ${r.out}`).toBe(0);
    }
    const wrong = folderOf('pilot', [], `${d}/pilot/${k}-p2`);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain(`${d}/pilot/${k}-p2`);
    expect(wrong.out).toContain(`${d}/pilot/${k}-p1`);
    for (const batch of ['smoke', 'pilot', 'effort']) {
      const only = folderOf(batch, ['-OnlySeed', '2', ...(batch === 'effort' ? ['-Effort', 'low'] : [])], `${d}/${batch}/w1`);
      expect(only.code, batch).toBe(1);
      expect(only.out, batch).toMatch(/-OnlySeed/);
    }
    const retry = folderOf('pilot', ['-Retry', '1'], `${d}/pilot/${k}-p1-a1`);
    expect(retry.code).toBe(1);
    expect(retry.out).toMatch(/-Retry/);
  }, 360_000);

  it('refuses a root or folder that is not in cygpath -m form, and a folder that already holds a run', () => {
    const d = world.dry.dir;
    const back = run(args({ more: ['-DryRun'] }).map((a) => (a === d ? d.replaceAll('/', '\\') : a)));
    expect(back.code).toBe(1);
    expect(back.out).toMatch(/cygpath -m/);
    const lower = run(args({ more: ['-DryRun'] }).map((a) => (a === d ? d.replace(/^C/, 'c') : a)));
    expect(lower.code).toBe(1);
    const trailing = run(args({ more: ['-DryRun'] }).map((a) => (a === d ? `${d}/` : a)));
    expect(trailing.code).toBe(1);
    const folderBack = run(args({ folder: `${d}\\smoke\\w1`, more: ['-DryRun'] }));
    expect(folderBack.code).toBe(1);
    expect(folderBack.out).toMatch(/cygpath -m/);
    mkdirSync(`${d}/smoke/w7/run`, { recursive: true });
    const held = run(args({ folder: `${d}/smoke/w7`, more: ['-Attempt', '7', '-DryRun'] }));
    expect(held.code).toBe(1);
    expect(held.out).toContain(`${d}/smoke/w7`);
    mkdirSync(`${d}/smoke/w8`, { recursive: true });
    writeFileSync(`${d}/smoke/w8/run.log`, 'old\n');
    expect(run(args({ folder: `${d}/smoke/w8`, more: ['-Attempt', '8', '-DryRun'] })).code).toBe(1);
  }, 360_000);

  it('a DRYRUN root needs -FakeAgent, and a real-shaped root refuses -FakeAgent and -BoxCheck, each with exit 1 and nothing started', () => {
    const noFake = run(args({ fake: false, more: ['-DryRun'] }));
    expect(noFake.code).toBe(1);
    expect(noFake.out).toMatch(/-FakeAgent/);
    const fakeOnReal = run(args({ root: world.real, folder: `${world.real.dir}/smoke/w1`, more: ['-FakeAgent', world.knobs, '-DryRun'] }));
    expect(fakeOnReal.code).toBe(1);
    expect(fakeOnReal.out).toMatch(/-FakeAgent/);
    const boxOnReal = run(args({ root: world.real, folder: `${world.real.dir}/smoke/w1`, more: ['-BoxCheck', world.stubBox.ok, '-DryRun'] }));
    expect(boxOnReal.code).toBe(1);
    expect(boxOnReal.out).toMatch(/-BoxCheck/);
    expect(untouched(`${world.dry.dir}/smoke/w1`) && untouched(`${world.real.dir}/smoke/w1`)).toBe(true);
  }, 240_000);

  it('a failing -BoxCheck stops with the box line last, and writes no run.log, exit.txt or pids line', () => {
    const r = run(args({ box: false, more: ['-BoxCheck', world.stubBox.bad] }));
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe('box check failed: reboot before a scored session');
    expect(untouched(`${world.dry.dir}/smoke/w1`)).toBe(true);
  }, 120_000);

  it('a one-byte change to a pinned file stops with its PINS: line and exit 3, and nothing starts', () => {
    const file = `${world.dry.dir}/tasks/${KEYS.npm}/tasks-run.json`;
    const text = readFileSync(file, 'utf8');
    try {
      writeFileSync(file, text.replace('look around only', 'Look around only'));
      const r = run(args({ more: ['-DryRun'] }));
      expect(r.code, r.out).toBe(3);
      expect(r.lines.some((l) => l.startsWith(`PINS: ${PINNED} is pinned`))).toBe(true);
      expect(untouched(`${world.dry.dir}/smoke/w1`)).toBe(true);
    } finally {
      writeFileSync(file, text);
    }
    expect(run(args({ more: ['-DryRun'] })).code).toBe(0);
  }, 180_000);

  it('-PlanOnly writes <folder>/dry/plan.json through ab-run --dry-run, and no run.log, exit.txt or pids line; a python key\'s venv flags pass ab-run\'s own checks', () => {
    for (const [key, toolchain] of [[KEYS.npm, 'npm'], [KEYS.python, 'python']]) {
      const folder = `${world.dry.dir}/smoke/w${key === KEYS.npm ? 3 : 4}`;
      const r = run(args({ key, toolchain, folder, more: ['-Attempt', key === KEYS.npm ? '3' : '4', '-MaxPosition', '1', '-PlanOnly'] }));
      expect(r.code, r.out).toBe(0);
      const plan: { arm: string; position: number }[] = JSON.parse(readFileSync(`${folder}/dry/plan.json`, 'utf8'));
      // -MaxPosition 1 keeps position 0 only, once for each of S1's seeds.
      expect(plan.length).toBeGreaterThan(0);
      for (const c of plan) expect([c.arm, c.position]).toEqual(['S1', 0]);
      expect(untouched(folder)).toBe(true);
      expect(existsSync(`${folder}/run`)).toBe(false);
    }
  }, 240_000);

  it('launches the runner: run pid is the first line while it lives, its pids line is there, its command line names ab-run.mjs and <folder>/run, the call waits, and exit.txt holds its exit code', async () => {
    const folder = `${world.dry.dir}/smoke/w5`;
    const seen: { pid: number; pids: string; commandLine: string; alive: boolean }[] = [];
    const r = await launchLive(RUN_PS, args({ key: KEYS.slow, folder, more: ['-Attempt', '5', '-MaxPosition', '1'] }), (line) => {
      const m = /^run pid (\d+)$/.exec(line);
      expect(m, line).not.toBeNull();
      const pid = Number(m![1]);
      seen.push({ pid, pids: existsSync(`${world.dry.dir}/smoke/pids.txt`) ? readFileSync(`${world.dry.dir}/smoke/pids.txt`, 'utf8') : '', commandLine: commandLineOf(pid), alive: alive(pid) });
    });
    expect(seen).toHaveLength(1);
    const [first] = seen;
    expect(first!.alive).toBe(true);
    expect(first!.pids).toContain(`${KEYS.slow} ${first!.pid} ${folder}\n`);
    expect(first!.commandLine).toContain('ab-run.mjs');
    expect(slash(first!.commandLine)).toContain(`${folder}/run`);
    expect(r.code, r.out).toBe(0);
    expect(r.lines[0]).toBe(`run pid ${first!.pid}`);
    expect(alive(first!.pid)).toBe(false);
    expect(readFileSync(`${folder}/run/exit.txt`, 'utf8')).toBe('0\n');
    expect(readFileSync(`${folder}/run.log`, 'utf8').split(/\r?\n/).some((l) => l.startsWith('Records:'))).toBe(true);
    expect(readFileSync(`${world.dry.dir}/smoke/pids.txt`, 'utf8').endsWith('\n')).toBe(true);
    expect(readFileSync(`${world.dry.dir}/smoke/pids.txt`, 'utf8')).not.toContain('\r');
  }, 300_000);

  it('a runner that fails by warmupFail exits 1, writes run/ABANDONED and exit.txt 1, and prints no Records: line', () => {
    const knobs = knobsFile(`${world.base}/misc`, { warmupFail: [SONNET_MODEL] });
    const folder = `${world.dry.dir}/smoke/w6`;
    const r = run(args({ folder, more: ['-Attempt', '6', '-MaxPosition', '1'] }).map((a) => (a === world.knobs ? knobs : a)));
    expect(r.code, r.out).toBe(1);
    expect(r.lines[0]).toMatch(/^run pid \d+$/);
    expect(existsSync(`${folder}/run/ABANDONED`)).toBe(true);
    expect(readFileSync(`${folder}/run/exit.txt`, 'utf8')).toBe('1\n');
    expect(readFileSync(`${folder}/run.log`, 'utf8').split(/\r?\n/).some((l) => l.startsWith('Records:'))).toBe(false);
  }, 300_000);

  describe('s4-regrade.ps1 over a stub z0-regrade.mjs', () => {
    const batch = (name: string) => {
      const folder = `${world.dry.dir}/batch1/${name}`;
      mkdirSync(`${folder}/run`, { recursive: true });
      return folder;
    };
    const rargs = (key: string, toolchain: string, folder: string, callName: string) => [
      '-Checkout', world.checkout, '-Root', world.dry.dir, '-Key', key, '-Toolchain', toolchain, '-Folder', folder, '-Call', callName, '-BoxCheck', world.stubBox.ok,
    ];
    interface StubCall { argv: string[]; cwd: string; placeholder: boolean; venv: string | null; venvOnPath: boolean }
    const calls = (folder: string) => readFileSync(`${folder}/stub-calls.jsonl`, 'utf8').trim().split('\n').map((line): StubCall => JSON.parse(line));

    it('blocks until the stub ends, has its regrade-pids line before <call> pid <n>, exits with the stub\'s code, and logs to g5-<call>.log and .err', async () => {
      const folder = batch(`${KEYS.npm}-w1`);
      writeFileSync(`${folder}/stub-exit.txt`, '7');
      const seen: string[] = [];
      const r = await launchLive(REGRADE_PS, rargs(KEYS.npm, 'npm', folder, 'grading'), (line) => {
        seen.push(line);
        const pids = `${world.dry.dir}/batch1/regrade-pids.txt`;
        seen.push(existsSync(pids) ? readFileSync(pids, 'utf8') : '');
      });
      expect(r.code, r.out).toBe(7);
      const pid = Number(/^grading pid (\d+)$/.exec(seen[0]!)?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(seen[1]).toBe(`${KEYS.npm} ${pid} ${folder} grading\n`);
      expect(alive(pid)).toBe(false);
      expect(existsSync(`${folder}/g5-grading.log`) && existsSync(`${folder}/g5-grading.err`)).toBe(true);
      expect(calls(folder)).toHaveLength(1);
    }, 300_000);

    it('passes each call\'s argv, the placeholder token, the folder as cwd, and no VIRTUAL_ENV or venv Scripts folder for a python key', () => {
      const folder = batch(`${KEYS.python}-w1`);
      const t = `${world.dry.dir}/tasks/${KEYS.python}/tasks-run.json`;
      const out = `${folder}/run`;
      const expected = {
        regrade: ['regrade', '--out', out, '--tasks', t, '--poetry', POETRY, '--pip-constraint', `${world.dry.dir}/pip-constraints.txt`],
        'reader-draw': ['reader', '--out', out, '--tasks', t, '--seed', '20261110', '--n', '5'],
        'stored-draw': ['stored', '--out', out, '--tasks', t, '--seed', '20261110', '--n', '2'],
        'reader-score': ['reader', '--out', out, '--labels', `${out}/g5/reader-r1/labels.tsv`],
        'stored-score': ['stored', '--out', out, '--labels', `${out}/g5/stored/labels.tsv`],
        grading: ['grading', '--out', out],
      };
      for (const name of Object.keys(expected)) {
        const r = regrade(rargs(KEYS.python, 'python', folder, name));
        expect(r.code, `${name}: ${r.out}`).toBe(0);
        expect(r.lines[0], name).toMatch(new RegExp(`^${name} pid \\d+$`));
      }
      const seen = calls(folder);
      expect(seen.map((c) => c.argv.slice(1))).toEqual(Object.values(expected));
      for (const c of seen) {
        expect(slash(c.argv[0]!)).toBe(`${world.checkout}/scripts/token-eval/z0-regrade.mjs`);
        expect([c.placeholder, c.venv, c.venvOnPath, c.cwd]).toEqual([true, null, false, folder]);
      }
      expect(readFileSync(`${world.dry.dir}/batch1/regrade-pids.txt`, 'utf8').trim().split('\n').filter((l) => l.includes(`${KEYS.python} `)).map((l) => l.split(' ').slice(2))).toEqual(
        Object.keys(expected).map((name) => [folder, name]),
      );
    }, 600_000);

    it('takes the pilot tasks under smoke, adds no poetry flags for npm, and stops on a failing box check, a missing run folder or an unknown call', () => {
      const smoke = `${world.dry.dir}/smoke/w9`;
      mkdirSync(`${smoke}/run`, { recursive: true });
      const r = regrade(rargs(KEYS.npm, 'npm', smoke, 'regrade'));
      expect(r.code, r.out).toBe(0);
      expect(calls(smoke)[0]!.argv.slice(1)).toEqual(['regrade', '--out', `${smoke}/run`, '--tasks', `${world.dry.dir}/pilot-tasks/${KEYS.npm}/tasks-run.json`]);
      const folder = batch(`${KEYS.npm}-w3`);
      const bad = regrade(rargs(KEYS.npm, 'npm', folder, 'regrade').map((a) => (a === world.stubBox.ok ? world.stubBox.bad : a)));
      expect(bad.code).toBe(1);
      expect(bad.lines.at(-1)).toBe('box check failed: reboot before a scored session');
      expect(existsSync(`${folder}/stub-calls.jsonl`) || existsSync(`${folder}/g5-regrade.log`)).toBe(false);
      expect(regrade(rargs(KEYS.npm, 'npm', `${world.dry.dir}/batch1/${KEYS.npm}-w4`, 'regrade')).code).toBe(1);
      expect(regrade(rargs(KEYS.npm, 'npm', folder, 'nonsense')).code).not.toBe(0);
    }, 360_000);
  });

  describe.skipIf(!HAVE_USER_TOKEN)(`a real-shaped root: the argv names the box's claude.exe and the ${TOKEN_VAR} user variable, never its value (skipped without that user variable)`, () => {
    const realArgs = (over: Parameters<typeof args>[0] = {}) => args({ root: world.real, folder: `${world.real.dir}/smoke/w1`, ...over });

    it('-DryRun gives --claude-bin, no --fake-agent, and `token user env var <name>`; a python key adds the venv flags', () => {
      for (const [key, toolchain] of [[KEYS.npm, 'npm'], [KEYS.python, 'python']]) {
        const r = run(realArgs({ key, toolchain, more: ['-DryRun'] }));
        expect(r.code, r.out).toBe(0);
        const argv = argvOf(r);
        expect(valueOf(argv, '--claude-bin')).toBe(CLAUDE_BIN);
        for (const flag of ['--fake-agent', '--model', '--token-schedule', '--token-var']) expect(argv, flag).not.toContain(flag);
        expect(countOf(argv, '--venv')).toBe(toolchain === 'python' ? 1 : 0);
        expect(r.lines.at(-1)).toBe(`token user env var ${TOKEN_VAR}`);
        expect(r.out).not.toMatch(/sk-ant|oat\d\d/);
      }
    }, 240_000);

    it('-TokenSchedule adds --token-schedule and --token-var on a real root, and a DRYRUN root refuses it', () => {
      const schedule = `${world.base}/misc/schedule.txt`;
      writeFileSync(schedule, '');
      const r = run(realArgs({ more: ['-TokenSchedule', schedule, '-TokenVar', TOKEN_VAR, '-DryRun'] }));
      expect(r.code, r.out).toBe(0);
      const argv = argvOf(r);
      expect([valueOf(argv, '--token-schedule'), valueOf(argv, '--token-var')]).toEqual([schedule, TOKEN_VAR]);
      const dry = run(args({ more: ['-TokenSchedule', schedule, '-DryRun'] }));
      expect(dry.code).toBe(1);
    }, 240_000);

    it('a user variable that is not set exits 1 naming it', () => {
      const r = run(realArgs({ more: ['-TokenVar', 'Z0_NO_SUCH_TOKEN_VAR', '-DryRun'] }));
      expect(r.code).toBe(1);
      expect(r.lines.at(-1)).toBe('User env var Z0_NO_SUCH_TOKEN_VAR is not set');
    }, 120_000);
  });
});
