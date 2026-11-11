// kill-own's sweep finds and stops a folder's processes with their descendants, reads a non-ASCII folder, and refuses a mark that could match unrelated processes.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitBash } from '../scripts/token-eval/homes.mjs';
import { killNaming, procsNaming } from './fixtures/kill-own.js';

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

describe.skipIf(!win)('kill-own on Windows', () => {
  it('a sweep finds and stops a descendant two levels down whose command line does not name the folder', async () => {
    const mark = folder('z0-own-');
    const aux = folder('z0-aux-');
    const tick = join(aux, 'tick.txt');
    const tickPid = join(aux, 'tick.pid');
    const stop = join(aux, 'stop');
    stops.push(stop);
    const until90s = `const fs = require('fs'); const end = Date.now() + 90000; const done = () => fs.existsSync(process.env.Z0_TICK_STOP) || Date.now() > end;`;
    writeFileSync(join(aux, 'mid.js'), `${until90s} require('child_process').spawn(process.execPath, [${JSON.stringify(join(aux, 'tick.js'))}], { stdio: 'ignore' }); setInterval(() => { if (done()) process.exit(0); }, 200);`);
    writeFileSync(join(aux, 'tick.js'), `${until90s} fs.writeFileSync(process.env.Z0_TICK_PID, String(process.pid)); setInterval(() => { if (done()) process.exit(0); fs.appendFileSync(process.env.Z0_TICK, '.'); }, 200);`);
    // Scenario S's shape: bash -c runs its one command in place of a fork, so only bash names the folder, and node mid.js and its tick child do not.
    const outer = spawn(gitBash(process.env, []), ['-c', `"${fwd(process.execPath)}" "${fwd(aux)}/mid.js" # ${fwd(mark)}`], {
      env: { ...process.env, Z0_TICK: tick, Z0_TICK_PID: tickPid, Z0_TICK_STOP: stop }, stdio: 'ignore', windowsHide: true, cwd: tmpdir(),
    });
    started.push(outer);
    await until('the tick to start', () => existsSync(tickPid) && existsSync(tick));
    const pid = Number(readFileSync(tickPid, 'utf8'));

    expect(procsNaming([mark]).get(mark)).toContain(pid);
    expect(killNaming([mark])).toContain(pid);
    const size = statSync(tick).size;
    await sleep(1500);
    expect(statSync(tick).size).toBe(size);
    expect(procsNaming([mark]).get(mark)).toEqual([]);
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

describe('kill-own marks', () => {
  // Only the read is given a broad mark, and the kill a relative mark no process names, so a regression here can never end an unrelated process.
  it('refuses an empty, relative or root mark before it reads or kills anything', () => {
    for (const mark of ['', '   ', 'node', parse(tmpdir()).root]) expect(() => procsNaming([mark]), JSON.stringify(mark)).toThrow(/absolute folder path/);
    expect(() => killNaming([`z0-no-such-mark-${process.pid}-${Date.now()}`])).toThrow(/absolute folder path/);
  });
});
