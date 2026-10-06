// The one problems line `hippo last-sleep` shows the user at session start, and where it goes.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cmdLastSleep, sleepProblems } from '../src/cli/last-sleep.js';
import { initProject, oneLine, removeScratch, runHippo, scratch, type Scratch } from './_helpers/compaction-hooks.js';

let s: Scratch;
let logFile: string;

beforeEach(() => {
  s = scratch();
  logFile = path.join(s.dir, 'logs', 'last-sleep.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  removeScratch(s);
});

const CLEAN = ['[hippo] 2026-10-06T09:00:00.000Z consolidating memory...', 'Consolidated 3 memories', '[hippo] sleep complete', 'closed 1 active snapshot(s) for session abc'];
const writeLog = (lines: string[]): void => fs.writeFileSync(logFile, `${lines.join('\n')}\n`);

describe('sleepProblems', () => {
  it('sleepProblems returns null for a clean log and for skip lines', () => {
    expect(sleepProblems(CLEAN.join('\n'), 0)).toBeNull();
    expect(sleepProblems('skip: no hippo store for this folder or globally\nskip sleep: this folder has no store of its own\n', 0)).toBeNull();
    expect(sleepProblems('', 0)).toBeNull();
  });

  it('counts only marked lines', () => {
    const log = [
      '[hippo] compaction replay: spool file a.a0.json is not readable, set aside as .bad',
      '[hippo] compaction replay: spool file b.a2.json set aside as .bad after 3 tries: boom',
      '[hippo] compaction replay: spool problem: spool file f.a0.json not claimed: EIO: i/o error',
      '[hippo] compaction replay: spool problem: spool lock not released: EIO: i/o error',
      '[hippo] compaction replay: replay failed: database is locked',
      '[hippo] compaction replay: spool file c.a0.json failed to import (try 1 of 3): boom',
      '[hippo] compaction replay: spool file d.a0.json waits for the next run: the store is busy',
      '[hippo] compaction replay: spool left to another replayer (lock held by pid 4)',
      '[hippo] compaction replay: spool file e.a0.json saved; writing its memories failed: boom',
    ].join('\r\n');
    expect(sleepProblems(log, 0)).toBe('Hippo: 2 errors while saving waiting compaction summaries. Run hippo doctor for details.');
  });

  it('names a failed sleep, the errors and the .bad count in one line, counting a set-aside file once', () => {
    const log = [
      '[hippo] compaction replay: spool file a.a0.json is not readable, set aside as .bad',
      '[hippo] compaction replay: spool problem: spool file b.a0.json not claimed: EIO: i/o error',
      '[hippo] sleep failed: store locked',
    ].join('\n');
    expect(sleepProblems(log, 1)).toBe('Hippo: the last sleep failed (store locked); 1 error while saving waiting compaction summaries; 1 compaction summary set aside as .bad. Run hippo doctor for details.');
    expect(sleepProblems(`[hippo] sleep failed: ${'x'.repeat(300)}`, 3)).toBe(`Hippo: the last sleep failed (${'x'.repeat(120)}); 3 compaction summaries set aside as .bad. Run hippo doctor for details.`);
  });
});

describe('cmdLastSleep output', () => {
  interface Streams {
    stdout: string[];
    errors: string[];
  }

  /** Captures stdout and every stderr route the command uses, so nothing reaches the test runner. */
  function capture(): Streams {
    const streams: Streams = { stdout: [], errors: [] };
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { streams.stdout.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { streams.errors.push(args.map(String).join(' ')); });
    return streams;
  }

  function withTty(isTTY: boolean): void {
    const was = process.stdout.isTTY;
    process.stdout.isTTY = isTTY;
    onTestFinished(() => { process.stdout.isTTY = was; });
  }

  it('a TTY with no mode gets terminal output', () => {
    withTty(true);
    writeLog([...CLEAN, '[hippo] sleep failed: store locked']);
    const streams = capture();
    cmdLastSleep(s.hippoRoot, { path: logFile });
    expect(streams.stdout).toEqual([]);
    expect(streams.errors).toContain('Hippo: the last sleep failed (store locked). Run hippo doctor for details.');
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('terminal mode writes the problems line to stderr and nothing to stdout', () => {
    withTty(false);
    writeLog([...CLEAN, '[hippo] sleep failed: store locked']);
    const streams = capture();
    cmdLastSleep(s.hippoRoot, { path: logFile }, 'terminal');
    expect(streams.stdout).toEqual([]);
    expect(streams.errors.at(-1)).toBe('Hippo: the last sleep failed (store locked). Run hippo doctor for details.');
  });
});

describe('hippo last-sleep', () => {
  it('prints nothing on stdout in a clean folder', () => {
    initProject(s);
    writeLog(CLEAN);
    const r = runHippo(['last-sleep', '--path', logFile], s.proj, s.env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    for (const line of CLEAN) expect(r.stderr).toContain(line);
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('prints nothing on stdout with no project and no global store', () => {
    writeLog(CLEAN);
    const r = runHippo(['last-sleep', '--path', logFile], s.proj, s.env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(s.hippoRoot)).toBe(false);
    expect(fs.existsSync(s.globalRoot)).toBe(false);
  });

  it('prints one systemMessage line when the spool holds a .bad file', () => {
    initProject(s);
    fs.mkdirSync(path.join(s.hippoRoot, 'compactions-spool'));
    fs.writeFileSync(path.join(s.hippoRoot, 'compactions-spool', '0000000001000-aaaaaaaa.unreadable.bad'), '{');
    writeLog(CLEAN);
    const r = runHippo(['last-sleep', '--path', logFile], s.proj, s.env);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(oneLine(r.stdout))).toEqual({ systemMessage: 'Hippo: 1 compaction summary set aside as .bad. Run hippo doctor for details.' });
    for (const line of CLEAN) expect(r.stderr).toContain(line);
  });
});
