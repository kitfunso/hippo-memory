// A program file planted in the folder a launch runs in must never stand in for the tool hippo
// meant to start.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnArgv } from '../../src/host/spawn-argv.js';
import { restrictToCurrentUser } from '../../src/host/windows-acl.js';
import { collectHandoffEvidence } from '../../src/surface/capture/handoff-evidence.js';

// The stand-in is node itself, which runs its first argument as a script that leaves a marker.
const MARKER = 'stand-in-ran';
const SCRIPT = `process.getBuiltinModule('node:fs').writeFileSync('${MARKER}', 'x');`;

let dir: string;
let home: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-planted-'));
  home = process.cwd();
  for (const tool of ['git', 'icacls', 'hippo-stand-in']) {
    copyFileSync(process.execPath, join(dir, `${tool}.exe`));
  }
  for (const script of ['rev-parse', 'status', 'run-me', 'target']) {
    writeFileSync(join(dir, script), SCRIPT);
  }
});
afterEach(() => {
  process.chdir(home);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(join(dir, MARKER), { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  // Some shells set this, which turns the working-folder search off and would hide the hole.
  vi.stubEnv('NoDefaultCurrentDirectoryInExePath', undefined);
});

const ran = (): boolean => existsSync(join(dir, MARKER));

describe.runIf(process.platform === 'win32')('a tool planted in the working folder', () => {
  it('is not run by spawnArgv, which fails the start with ENOENT instead', async () => {
    let failure: unknown;
    try {
      const child = spawnArgv(['hippo-stand-in', 'run-me'], { cwd: dir, stdio: 'ignore' });
      await new Promise((done) => child.on('close', done).on('error', done));
    } catch (err) {
      failure = err;
    }
    expect(ran()).toBe(false);
    expect(failure).toMatchObject({ code: 'ENOENT' });
  });

  it('leaves spawnArgv running a .cmd shim that sits on PATH before an .exe', async () => {
    const shims = join(dir, 'shims');
    mkdirSync(shims, { recursive: true });
    writeFileSync(join(shims, 'hippo-stand-in.cmd'), `@echo shim> "${join(dir, MARKER)}"\r\n`);
    vi.stubEnv('PATH', `${shims};${dir};${join(process.env.SystemRoot ?? 'C:/Windows', 'System32')}`);
    vi.stubEnv('PATHEXT', '.com;.exe;.bat;.cmd');
    const child = spawnArgv(['hippo-stand-in'], { stdio: 'ignore' });
    await new Promise((done) => child.on('close', done).on('error', done));
    expect(readFileSync(join(dir, MARKER), 'utf8').trim()).toBe('shim');
  });

  it('is not run as git by the handoff evidence reader', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    collectHandoffEvidence(dir, 'unknown', { timeoutMs: 20_000 });
    expect(ran()).toBe(false);
  });

  it('is not run as icacls when the key file is restricted', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.chdir(dir);
    restrictToCurrentUser(join(dir, 'target'));
    expect(ran()).toBe(false);
  });
});
