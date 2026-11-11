// stop-tree.ps1 (plan amendment W4-49) stops a root and its descendants oldest first, refuses a root that names another folder, and s4-units.sh stop_finished leaves alive a process that took a listed pid.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitBash } from '../scripts/token-eval/homes.mjs';

// Each stop runs PowerShell process reads, which take seconds on a loaded box.
vi.setConfig({ testTimeout: 120_000 });

const win = process.platform === 'win32';
const CHECKOUT = resolve(__dirname, '..');
const STOP_TREE = join(CHECKOUT, 'scripts', 'token-eval', 'stop-tree.ps1');
const fwd = (p: string) => p.replace(/\\/g, '/');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const exited = (child: ChildProcess) => new Promise<void>((done) => {
  if (child.exitCode !== null || child.signalCode !== null) done();
  else child.once('exit', () => done());
});
async function until(what: string, test: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const started: ChildProcess[] = [];
const dirs: string[] = [];
const stops: string[] = [];
const folder = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

afterEach(async () => {
  // Every process here ends itself once its stop file exists, so the test never signals a pid it holds no handle to.
  for (const f of stops.splice(0)) writeFileSync(f, '');
  for (const child of started.splice(0)) {
    child.kill();
    await exited(child);
  }
  await sleep(500);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

/** node root.js --out <names>/run, which starts a detached tick child (out of root's libuv job, so only the walk ends it); the tick writes its pid and a dot every 200 ms. */
function treeNaming(names: string) {
  const aux = folder('z0-stop-aux-');
  const tick = join(aux, 'tick.txt');
  const tickPid = join(aux, 'tick.pid');
  const stop = join(aux, 'stop');
  stops.push(stop);
  const until90s = `const fs = require('fs'); const end = Date.now() + 90000; const done = () => fs.existsSync(process.env.Z0_TICK_STOP) || Date.now() > end;`;
  writeFileSync(join(aux, 'root.js'), `${until90s} require('child_process').spawn(process.execPath, [${JSON.stringify(join(aux, 'tick.js'))}], { stdio: 'ignore', detached: true }); setInterval(() => { if (done()) process.exit(0); }, 200);`);
  writeFileSync(join(aux, 'tick.js'), `${until90s} fs.writeFileSync(process.env.Z0_TICK_PID, String(process.pid)); setInterval(() => { if (done()) process.exit(0); fs.appendFileSync(process.env.Z0_TICK, '.'); }, 200);`);
  const env = { ...process.env, Z0_TICK: tick, Z0_TICK_PID: tickPid, Z0_TICK_STOP: stop };
  const root = spawn(process.execPath, [join(aux, 'root.js'), '--out', join(names, 'run')], { env, stdio: 'ignore', windowsHide: true, cwd: tmpdir() });
  started.push(root);
  const ready = async () => {
    await until('the tick to start', () => existsSync(tickPid) && existsSync(tick));
    return Number(readFileSync(tickPid, 'utf8'));
  };
  const stopped = async () => {
    const size = statSync(tick).size;
    await sleep(1500);
    return statSync(tick).size === size;
  };
  return { pid: Number(root.pid), root, ready, stopped };
}

/** stop-tree.ps1's exit code and output lines. */
function stopTree(rootPid: number, flags: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', STOP_TREE, '-RootPid', String(rootPid), ...flags], { env, encoding: 'utf8', windowsHide: true });
  return { code: r.status, lines: `${r.stdout}`.split(/\r?\n/).filter(Boolean), stderr: r.stderr };
}

describe.skipIf(!win)('stop-tree.ps1', () => {
  it('stops a root that names the folder and its descendant, oldest first, then prints end and exits 0', async () => {
    const unit = folder('z0-stop-unit-');
    const t = treeNaming(unit);
    const tick = await t.ready();
    const r = stopTree(t.pid, ['-Mark', unit]);
    expect([r.code, r.lines.at(-1)], r.stderr).toEqual([0, 'end']);
    expect(r.lines).toEqual(expect.arrayContaining([`killed ${t.pid}`, `killed ${tick}`]));
    expect(r.lines.indexOf(`killed ${t.pid}`)).toBeLessThan(r.lines.indexOf(`killed ${tick}`));
    expect(await t.stopped()).toBe(true);
    await exited(t.root);
  });

  it('refuses a root whose command line names another folder, one whose name starts with the mark, and kills nothing (exit 3)', async () => {
    const unit = folder('z0-stop-unit-');
    const other = `${unit}-a2`;
    mkdirSync(other);
    dirs.push(other);
    const t = treeNaming(other);
    await t.ready();
    const r = stopTree(t.pid, ['-Mark', unit]);
    expect(await t.stopped(), 'the bystander\'s descendant stopped ticking').toBe(false);
    expect(t.root.exitCode ?? t.root.signalCode, 'the bystander exited').toBeNull();
    expect([r.code, r.lines], r.stderr).toEqual([3, [expect.stringMatching(new RegExp(`^not-mine ${t.pid} `)), 'end']]);
  });

  it('says gone and exits 0 for a pid no process holds', async () => {
    const unit = folder('z0-stop-unit-');
    const child = spawn(process.execPath, ['-e', '', join(unit, 'run')], { stdio: 'ignore', windowsHide: true, cwd: tmpdir() });
    await exited(child);
    // The mark keeps this harmless if another process took the pid meanwhile: the script refuses it rather than kill it.
    const r = stopTree(Number(child.pid), ['-Mark', unit]);
    expect([r.code, r.lines], r.stderr).toEqual([0, [`gone ${child.pid}`, 'end']]);
  });

  it('kills a child that a root starts during the stop, or exits 1, and never exits 0 with one alive', async () => {
    const unit = folder('z0-stop-unit-');
    const aux = folder('z0-stop-aux-');
    const stop = join(aux, 'stop');
    stops.push(stop);
    const kids = join(aux, 'kids.txt');
    const until60s = `const fs = require('fs'); const end = Date.now() + 60000; const done = () => fs.existsSync(${JSON.stringify(stop)}) || Date.now() > end;`;
    writeFileSync(join(aux, 'kid.js'), `${until60s} const f = ${JSON.stringify(join(aux, 'tick-'))} + process.pid; setInterval(() => { if (done()) process.exit(0); fs.appendFileSync(f, '.'); }, 100);`);
    // A detached child every 250 ms, so children keep appearing while the stop reads, holds and kills.
    writeFileSync(join(aux, 'spawner.js'), `${until60s} setInterval(() => { if (done()) process.exit(0); const c = require('child_process').spawn(process.execPath, [${JSON.stringify(join(aux, 'kid.js'))}], { stdio: 'ignore', detached: true }); fs.appendFileSync(${JSON.stringify(kids)}, c.pid + '\\n'); }, 250);`);
    const root = spawn(process.execPath, [join(aux, 'spawner.js'), '--out', join(unit, 'run')], { stdio: 'ignore', windowsHide: true, cwd: tmpdir() });
    started.push(root);
    await until('two children', () => existsSync(kids) && readFileSync(kids, 'utf8').split('\n').filter(Boolean).length >= 2);
    const r = stopTree(Number(root.pid), ['-Mark', unit]);
    const sizes = () => new Map(readdirSync(aux).filter((f) => f.startsWith('tick-')).map((f) => [f, statSync(join(aux, f)).size]));
    const before = sizes();
    await sleep(1500);
    const alive = [...sizes()].filter(([f, size]) => before.get(f) !== size).map(([f]) => f);
    expect([0, 1], r.lines.join('\n')).toContain(r.code);
    expect(r.code === 0 ? alive : [], `children still ticking after exit 0\n${r.lines.join('\n')}`).toEqual([]);
  });
});

describe.skipIf(!win)('stop-tree.ps1 over a listed process table', () => {
  // Z0_STOP_TREE_LISTED is {root, reads}: root is the start a handle on the root reports (null: gone), reads one table per round, the last one repeating.
  // A row's HandleStart is what a handle opened right after that read would report (absent: its CreationDate; null: gone). The script runs its real rounds but opens no handle and kills nothing.
  const mark = 'C:/z0-listed-mark';
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const row = (id: number, parent: number, s: number, line = 'node x.js') => ({ ProcessId: id, ParentProcessId: parent, CreationDate: at(s), CommandLine: line });
  const root = row(101, 4, 10, `node ${mark}/run.js`);
  const listedRun = (reads: object[][], flags = ['-Mark', mark], rootStart: string | null = at(10)) =>
    stopTree(101, flags, { ...process.env, Z0_STOP_TREE_LISTED: JSON.stringify({ root: rootStart, reads }) });

  it('takes a child only if it started at or after its parent, and nothing under a child it refused, oldest first with pid breaking ties', () => {
    const r = listedRun([[root, row(102, 101, 20), row(103, 101, 5), row(104, 103, 30), row(105, 101, 10), row(106, 102, 25), row(107, 101, 15)]]);
    expect([r.code, r.lines], r.stderr).toEqual([4, ['listed 101', 'listed 105', 'listed 107', 'listed 102', 'listed 106', 'end']]);
  });

  // Sort-Object in PowerShell 5.1 is not stable, so only the pid key fixes the order of a tie.
  it('orders two processes that started together by pid, whatever their order in the table', () => {
    for (const pair of [[108, 109], [109, 108]]) {
      const r = listedRun([[root, ...pair.map((id) => row(id, 101, 20))]]);
      expect([r.code, r.lines], `${pair} ${r.stderr}`).toEqual([4, ['listed 101', 'listed 108', 'listed 109', 'end']]);
    }
  });

  it('holds and lists a child that appears in a later round', () => {
    const r = listedRun([[root, row(102, 101, 20)], [root, row(102, 101, 20), row(103, 101, 30)]]);
    expect([r.code, r.lines], r.stderr).toEqual([4, ['listed 101', 'listed 102', 'listed 103', 'end']]);
  });

  // The handle names the process: a start that differs from the row means the pid changed hands, so the row's children are not walked from it.
  it('says gone for a nominee whose handle start differs from its row, or whose handle finds it gone, and walks nothing from it', () => {
    const r = listedRun([[root, { ...row(102, 101, 20), HandleStart: at(40) }, { ...row(103, 101, 25), HandleStart: null }], [row(104, 102, 30), row(105, 103, 35)]]);
    expect([r.code, r.lines], r.stderr).toEqual([4, ['gone 102', 'gone 103', 'listed 101', 'end']]);
  });

  it('lists a grandchild whose parent was held and killed, and is gone from the next read', () => {
    const r = listedRun([[root, row(102, 101, 20)], [row(104, 102, 30)]]);
    expect([r.code, r.lines], r.stderr).toEqual([4, ['listed 101', 'listed 102', 'listed 104', 'end']]);
  });

  it('walks from every held pid, so a grandchild is found under a parent the next read no longer lists', () => {
    const r = listedRun([[root, row(102, 101, 20)], [root, row(104, 102, 30)]]);
    expect([r.code, r.lines], r.stderr).toEqual([4, ['listed 101', 'listed 102', 'listed 104', 'end']]);
  });

  // Neither caller gets another chance at a sixth round's nominees, so they are killed before the stop fails.
  it('kills a sixth round\'s new child, then fails (exit 1) as still spawning', () => {
    const chain = (n: number) => [root, ...Array.from({ length: n }, (_, i) => row(201 + i, i === 0 ? 101 : 200 + i, 20 + i))];
    const r = listedRun([1, 2, 3, 4, 5, 6].map(chain));
    expect([r.code, r.lines], r.stderr).toEqual([1, ['listed 101', 'listed 201', 'listed 202', 'listed 203', 'listed 204', 'listed 205', 'listed 206', 'failed 206 still spawning after 5 rounds', 'end']]);
  });

  // The root's start comes from its handle, opened before the first read, so a root that exits after that is walked like any held pid.
  it('walks from a root that exited after its handle opened, whether or not a read lists it', () => {
    for (const reads of [[[row(102, 101, 20)]], [[root], [row(102, 101, 20)]]]) {
      const r = listedRun(reads, ['-StartedBy', at(15)]);
      expect([r.code, r.lines], `${JSON.stringify(reads)} ${r.stderr}`).toEqual([4, ['listed 101', 'listed 102', 'end']]);
    }
  });

  it('refuses (exit 3) a root no read lists when -Mark needs its command line', () => {
    for (const reads of [[[]], [[row(102, 4, 10, `node ${mark}/run.js`), row(103, 101, 20)]]]) {
      const r = listedRun(reads);
      expect([r.code, r.lines], `${JSON.stringify(reads)} ${r.stderr}`).toEqual([3, ['not-mine 101 exited before its command line was read', 'end']]);
    }
  });

  // Exit 0 tells exec.mjs the child is stopped, so a leaked table must never give it.
  it('exits 4, never 0, for a root gone before its handle opens, whatever the tables list', () => {
    for (const reads of [[[]], [[root, row(102, 101, 20)]]]) {
      const r = listedRun(reads, ['-Mark', mark], null);
      expect([r.code, r.lines], `${JSON.stringify(reads)} ${r.stderr}`).toEqual([4, ['gone 101', 'end']]);
    }
  });

  // exec.mjs passes the time it still held the child's handle, so a root that started later holds a freed pid.
  it('refuses a root that started after -StartedBy (exit 3), before any listed line', () => {
    const r = listedRun([[root, row(102, 101, 20)]], ['-StartedBy', at(5)]);
    expect([r.code, r.lines], r.stderr).toEqual([3, [`not-mine 101 started after ${at(5)}`, 'end']]);
  });

  it('stops as usual a root that started before -StartedBy, with children that started after it', () => {
    const r = listedRun([[root, row(102, 101, 20)]], ['-StartedBy', at(15)]);
    expect([r.code, r.lines], r.stderr).toEqual([4, ['listed 101', 'listed 102', 'end']]);
  });

  it('takes a -StartedBy that is not a UTC round-trip time as a script error (exit 2)', () => {
    for (const bad of ['yesterday', '2026-01-01T00:00:15', '2026-01-01T00:00:15+01:00']) {
      const r = listedRun([[root]], ['-StartedBy', bad]);
      expect([r.code, r.lines], bad).toEqual([2, [`error -StartedBy ${bad} is not a UTC round-trip time`]]);
    }
  });
});

describe.skipIf(!win)('s4-units.sh stop_finished', () => {
  it('stops a finished runner with its descendant, and leaves alive a process that took a listed runner pid, saying its exit 3', async () => {
    const prefix = folder('z0-stop-batch-');
    const [u1, u2] = ['u1', 'u2'].map((u) => join(prefix, u));
    for (const u of [u1, u2]) {
      mkdirSync(join(u, 'run'), { recursive: true });
      writeFileSync(join(u, 'run.log'), `Records: ${join(u, 'run', 'runs.jsonl')}\n`);
    }
    const runner = treeNaming(u1);
    const bystander = treeNaming(folder('z0-stop-other-'));
    const tick = await runner.ready();
    await bystander.ready();
    // A fixed listing in place of s4-procs.ps1: the bystander's pid stands for a runner pid that passed to another process after the scan.
    const here = folder('z0-stop-scripts-');
    copyFileSync(join(CHECKOUT, 'scripts', 'token-eval', 'r4-launch', 's4-units.sh'), join(here, 's4-units.sh'));
    writeFileSync(join(here, 'listing.txt'), `${runner.pid} ab-run ${fwd(u1).toLowerCase()}\n${bystander.pid} ab-run ${fwd(u2).toLowerCase()}\n`);
    writeFileSync(join(here, 's4-procs.ps1'), `Get-Content -LiteralPath (Join-Path $PSScriptRoot 'listing.txt') | ForEach-Object { [Console]::Out.Write($_ + "\`n") }\nexit 0\n`);
    const r = spawnSync(gitBash(process.env, []), [fwd(join(here, 's4-units.sh')), 'stop_finished', fwd(prefix)], { env: { ...process.env, Z0_CHECKOUT: fwd(CHECKOUT), Z0_GRACE_S: '0' }, encoding: 'utf8', cwd: tmpdir() });
    const said = r.stderr.split(/\r?\n/).filter(Boolean);
    expect(await bystander.stopped(), 'the bystander\'s descendant stopped ticking').toBe(false);
    expect(bystander.root.exitCode ?? bystander.root.signalCode, 'the bystander exited').toBeNull();
    expect(r.status, r.stderr).toBe(0);
    expect(said).toEqual(expect.arrayContaining([`u1 finished but did not exit, stopping pid ${runner.pid}`, `u1 stop: killed ${runner.pid}`, `u1 stop: killed ${tick}`, 'u1 stop: end']));
    expect(said).toContain(`u2 finished but did not exit, stopping pid ${bystander.pid}`);
    expect(said.filter((l) => l.startsWith('u2 stop'))).toEqual([expect.stringMatching(new RegExp(`^u2 stop: not-mine ${bystander.pid} `)), 'u2 stop: end', expect.stringMatching(new RegExp(`^u2 stop exit 3: not-mine ${bystander.pid} `))]);
    expect(await runner.stopped()).toBe(true);
  });
});
