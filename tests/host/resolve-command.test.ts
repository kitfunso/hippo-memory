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
});

describe.runIf(process.platform !== 'win32')('resolveCommand elsewhere', () => {
  it('returns the name unchanged', () => {
    expect(resolveCommand('git')).toBe('git');
  });
});
