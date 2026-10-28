// Windows looks in the working folder before PATH for a bare name, so the resolver must never do.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCommand } from '../../src/host/spawn-argv.js';

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hippo-resolve-'));
  home = process.cwd();
});
afterEach(() => {
  process.chdir(home);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('resolveCommand on win32', () => {
  it('refuses a tool that sits only in the working folder, with ENOENT naming it', () => {
    const work = join(dir, 'work');
    const bin = join(dir, 'bin');
    mkdirSync(work);
    mkdirSync(bin);
    writeFileSync(join(work, 'hippo-stand-in.exe'), '');
    vi.stubEnv('PATH', bin);
    process.chdir(work);
    expect(() => resolveCommand('hippo-stand-in')).toThrow(
      expect.objectContaining({ code: 'ENOENT', message: expect.stringContaining('hippo-stand-in') }),
    );
  });

  it('takes the PATH copy even when the working folder holds one too', () => {
    const work = join(dir, 'work');
    const bin = join(dir, 'bin');
    mkdirSync(work);
    mkdirSync(bin);
    writeFileSync(join(work, 'hippo-stand-in.exe'), '');
    writeFileSync(join(bin, 'hippo-stand-in.exe'), '');
    vi.stubEnv('PATH', bin);
    vi.stubEnv('PATHEXT', '.exe');
    process.chdir(work);
    expect(resolveCommand('hippo-stand-in')).toBe(join(bin, 'hippo-stand-in.exe'));
  });

  it('uses a name with a folder as given', () => {
    expect(resolveCommand(join(dir, 'no-such-tool'))).toBe(join(dir, 'no-such-tool'));
  });

  it('finds a tool in a quoted PATH folder', () => {
    const bin = join(dir, 'Program Files', 'Git', 'cmd');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'git.exe'), '');
    vi.stubEnv('PATH', `"${bin}"`);
    expect(resolveCommand('git')).toBe(join(bin, 'git.exe'));
  });

  it('skips a relative PATH folder, which would name the working folder', () => {
    const work = join(dir, 'work');
    mkdirSync(work);
    writeFileSync(join(work, 'hippo-stand-in.exe'), '');
    vi.stubEnv('PATH', '.');
    process.chdir(work);
    expect(() => resolveCommand('hippo-stand-in')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('gives a launch with no shell the .exe behind an earlier .cmd, and spawnArgv the shim', () => {
    const shims = join(dir, 'shims');
    const bin = join(dir, 'bin');
    mkdirSync(shims);
    mkdirSync(bin);
    writeFileSync(join(shims, 'git.cmd'), '');
    writeFileSync(join(bin, 'git.exe'), '');
    vi.stubEnv('PATH', `${shims};${bin}`);
    vi.stubEnv('PATHEXT', '.com;.exe;.bat;.cmd');
    expect(resolveCommand('git')).toBe(join(bin, 'git.exe'));
    expect(resolveCommand('git', { shims: true })).toBe(join(shims, 'git.cmd'));
  });
});

describe.runIf(process.platform !== 'win32')('resolveCommand elsewhere', () => {
  it('returns the name unchanged', () => {
    expect(resolveCommand('git')).toBe('git');
  });
});
