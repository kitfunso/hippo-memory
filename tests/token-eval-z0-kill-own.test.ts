// kill-own's sweep and tree kill find and stop a test's processes with their descendants, read a non-ASCII folder, and refuse a mark that could match unrelated processes.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitBash } from '../scripts/token-eval/homes.mjs';
import { killNaming, killOwnTree, procsNaming } from './fixtures/kill-own.js';

// Each process read is a PowerShell CIM query, which takes seconds on a loaded box.
vi.setConfig({ testTimeout: 120_000 });

const win = process.platform === 'win32';
const fwd = (p: string) => p.replace(/\\/g, '/');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exited = (child: ChildProcess) => new Promise<void>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve();
  else child.once('exit', () => resolve());
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
  // The descendant ends itself once its stop file exists, so the test never kills a process it holds no handle to.
  for (const f of stops.splice(0)) writeFileSync(f, '');
  for (const child of started.splice(0)) {
    child.kill();
    await exited(child);
  }
  await sleep(500);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

// Each spawn of a child below is detached, so it leaves its parent's libuv job, which kills it when the parent dies; only the walk can then end it.
/** node mid.js, which starts node tick.js; neither command line names a test folder, the tick writes its pid and a dot every 200 ms, and both end once the stop file exists. */
function midAndTick() {
  const aux = folder('z0-aux-');
  const tick = join(aux, 'tick.txt');
  const tickPid = join(aux, 'tick.pid');
  const stop = join(aux, 'stop');
  stops.push(stop);
  const until90s = `const fs = require('fs'); const end = Date.now() + 90000; const done = () => fs.existsSync(process.env.Z0_TICK_STOP) || Date.now() > end;`;
  writeFileSync(join(aux, 'mid.js'), `${until90s} require('child_process').spawn(process.execPath, [${JSON.stringify(join(aux, 'tick.js'))}], { stdio: 'ignore', detached: true }); setInterval(() => { if (done()) process.exit(0); }, 200);`);
  writeFileSync(join(aux, 'tick.js'), `${until90s} fs.writeFileSync(process.env.Z0_TICK_PID, String(process.pid)); setInterval(() => { if (done()) process.exit(0); fs.appendFileSync(process.env.Z0_TICK, '.'); }, 200);`);
  const env = { ...process.env, Z0_TICK: tick, Z0_TICK_PID: tickPid, Z0_TICK_STOP: stop };
  const ready = async () => {
    await until('the tick to start', () => existsSync(tickPid) && existsSync(tick));
    return Number(readFileSync(tickPid, 'utf8'));
  };
  const stopped = async () => {
    const size = statSync(tick).size;
    await sleep(1500);
    return statSync(tick).size === size;
  };
  return { mid: join(aux, 'mid.js'), env, ready, stopped };
}

describe.skipIf(!win)('kill-own on Windows', () => {
  it('a sweep finds and stops a descendant two levels down whose command line does not name the folder', async () => {
    const mark = folder('z0-own-');
    const t = midAndTick();
    // Scenario S's shape: bash -c runs its one command in place of a fork, so only bash names the folder, and node mid.js and its tick child do not.
    started.push(spawn(gitBash(process.env, []), ['-c', `"${fwd(process.execPath)}" "${fwd(t.mid)}" # ${fwd(mark)}`], { env: t.env, stdio: 'ignore', windowsHide: true, cwd: tmpdir() }));
    const pid = await t.ready();

    expect(procsNaming([mark]).get(mark)).toContain(pid);
    expect(killNaming([mark])).toContain(pid);
    expect(await t.stopped()).toBe(true);
    expect(procsNaming([mark]).get(mark)).toEqual([]);
  });

  it('killOwnTree stops a child the test holds and its descendants, and leaves a child whose exit Node has seen alone', async () => {
    const t = midAndTick();
    const mid = spawn(process.execPath, [t.mid], { env: t.env, stdio: 'ignore', windowsHide: true, cwd: tmpdir() });
    started.push(mid);
    const pid = await t.ready();
    expect(killOwnTree(mid)).toEqual(expect.arrayContaining([mid.pid, pid]));
    expect(await t.stopped()).toBe(true);
    await exited(mid);
    expect(killOwnTree(mid)).toEqual([]);
  });

  it('a sweep kills oldest first, so a parent dies before the child it started, whatever the listing order', async () => {
    const mark = folder('z0-own-');
    const aux = folder('z0-aux-');
    const childPid = join(aux, 'child.pid');
    const stop = join(aux, 'stop');
    stops.push(stop);
    // Both command lines name the folder, so both are direct matches and only the kill order decides which dies first.
    const child = `const fs = require('fs'); const at = ${JSON.stringify(mark)}; fs.writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); const end = Date.now() + 90000; setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)}) || Date.now() > end) process.exit(0); }, 200);`;
    const parent = spawn(process.execPath, ['-e', `const at = ${JSON.stringify(mark)}; require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore', detached: true }); setInterval(() => {}, 1000);`], { stdio: 'ignore', windowsHide: true, cwd: tmpdir() });
    started.push(parent);
    await until('the child to start', () => existsSync(childPid));
    const order = killNaming([mark]);
    const kid = Number(readFileSync(childPid, 'utf8'));
    expect(order).toEqual(expect.arrayContaining([parent.pid, kid]));
    expect(order.indexOf(parent.pid ?? -1)).toBeLessThan(order.indexOf(kid));
  });

  it('a folder whose name holds a non-ASCII letter is found, and its process stopped', async () => {
    const dir = folder('z0-own-é-');
    const child = spawn(process.execPath, ['-e', `const at = ${JSON.stringify(dir)}; setInterval(() => {}, 1000);`], { stdio: 'ignore', windowsHide: true, cwd: tmpdir() });
    started.push(child);
    await new Promise((resolve) => child.once('spawn', resolve));
    expect(procsNaming([dir]).get(dir)).toContain(child.pid);
    expect(killNaming([dir])).toContain(child.pid);
    await Promise.race([exited(child), sleep(15_000)]);
    expect(child.exitCode ?? child.signalCode).not.toBeNull();
  });
});

describe.skipIf(!win)('kill-own\'s start-time check, over a listed process table', () => {
  // The listing replaces the live read for procsNaming only, so no kill ever acts on these pids.
  it('takes a child of a match only if it started at or after its parent, and nothing under a child it refused', () => {
    const mark = 'C:/z0-listed-mark';
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
    const listed = [
      { ProcessId: 101, ParentProcessId: 4, CreationDate: at(10), CommandLine: `node ${mark}/run.js` },
      { ProcessId: 102, ParentProcessId: 101, CreationDate: at(20), CommandLine: 'node younger.js' },
      { ProcessId: 103, ParentProcessId: 101, CreationDate: at(5), CommandLine: 'node older.js' },
      { ProcessId: 104, ParentProcessId: 103, CreationDate: at(30), CommandLine: 'node under-older.js' },
      { ProcessId: 105, ParentProcessId: 101, CreationDate: at(10), CommandLine: 'node same-time.js' },
    ];
    expect([...(procsNaming([mark], listed).get(mark) ?? [])].sort((a, b) => a - b)).toEqual([101, 102, 105]);
  });
});

describe('kill-own marks', () => {
  // Only the read is given a broad mark, and the kill a relative mark no process names, so a regression here can never end an unrelated process.
  it('refuses an empty, relative or root mark before it reads or kills anything', () => {
    for (const mark of ['', '   ', 'node', parse(tmpdir()).root]) expect(() => procsNaming([mark]), JSON.stringify(mark)).toThrow(/absolute folder path/);
    expect(() => killNaming([`z0-no-such-mark-${process.pid}-${Date.now()}`])).toThrow(/absolute folder path/);
  });
});
