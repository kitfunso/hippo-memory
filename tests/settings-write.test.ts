// How hippo replaces settings.json when another program holds it, it is read-only, the rename is refused, or the temp file cannot be written.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escapeRegex } from '../src/escape.js';
import { installJsonHooks, resolveJsonHookPaths } from '../src/hooks/json-hooks.js';
import { withFakeHome, type FakeHomeHandle } from './_helpers/with-fake-home.js';

const WINDOWS = process.platform === 'win32';
const ROOT = process.getuid?.() === 0;

let env: FakeHomeHandle;
beforeEach(() => {
  env = withFakeHome('hippo-settings-write-');
});
afterEach(() => env.cleanup());

function seed(): string {
  const { settings: file } = resolveJsonHookPaths('claude-code');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"theme":"dark"}', 'utf8');
  return file;
}

/** A child that opens `file` for reading and keeps it open for `ms`; resolves once the file is held. */
async function holdOpen(file: string, ms: number) {
  const script = `const fs = require('fs'); const fd = fs.openSync(process.argv[1], 'r'); console.log('held'); setTimeout(() => fs.closeSync(fd), ${ms});`;
  const child = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  return child;
}

describe.skipIf(!WINDOWS)('a settings.json another program has open (Windows refuses a rename onto it)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it('waits for the program to let go, then writes', async () => {
    const file = seed();
    const holder = await holdOpen(file, 300);

    expect(installJsonHooks('claude-code').installedSessionEnd).toBe(true);

    await once(holder, 'exit');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionEnd).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  it('after the retry, writes in place when the program only has the file open for reading', async () => {
    const file = seed();
    const holder = await holdOpen(file, 10_000);
    const started = Date.now();

    try {
      expect(installJsonHooks('claude-code').installedSessionEnd).toBe(true);
    } finally {
      holder.kill();
      await once(holder, 'exit');
    }

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionEnd).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  // The write is stubbed to EBUSY: no Windows open mode here lets a program stop writes while the file stays readable.
  it('gives up with an error that names the file when the in-place write is refused too, and leaves no temp file', async () => {
    const file = seed();
    const target = fs.realpathSync(file);
    const write = fs.writeFileSync.bind(fs);
    const holder = await holdOpen(file, 10_000);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((dest, data, options) => {
      if (dest === target) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      write(dest, data, options);
    });
    syncBuiltinESMExports();
    const started = Date.now();

    try {
      expect(() => installJsonHooks('claude-code')).toThrow(new RegExp(`${escapeRegex(target)}.*in use`));
    } finally {
      holder.kill();
      await once(holder, 'exit');
    }

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"dark"}');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });
});

function refuseRename(code: string): void {
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw Object.assign(new Error(`${code}: rename refused`), { code });
  });
  syncBuiltinESMExports();
}

describe('a rename the platform refuses (a bind-mounted file, a mount point)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it.each(['EBUSY', 'EXDEV'])('%s: the file is written in place, so the install still lands', (code) => {
    const file = seed();
    refuseRename(code);

    expect(installJsonHooks('claude-code').installedSessionEnd).toBe(true);

    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionEnd).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  it('another failure, such as a full disk, is thrown and leaves the file and folder as they were', () => {
    const file = seed();
    refuseRename('ENOSPC');

    expect(() => installJsonHooks('claude-code')).toThrow(/ENOSPC/);

    expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"dark"}');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  it('a failed cleanup of the temp file never replaces the error that made it necessary', () => {
    seed();
    refuseRename('ENOSPC');
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: another program holds the temp file'), { code: 'EPERM' });
    });
    syncBuiltinESMExports();

    expect(() => installJsonHooks('claude-code')).toThrow(/ENOSPC/);
  });

  it('throws only when the in-place write fails too, naming the file and the code', () => {
    const file = seed();
    const target = fs.realpathSync(file);
    const write = fs.writeFileSync.bind(fs);
    refuseRename('EBUSY');
    vi.spyOn(fs, 'writeFileSync').mockImplementation((dest, data, options) => {
      if (dest === target) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
      write(dest, data, options);
    });
    syncBuiltinESMExports();

    expect(() => installJsonHooks('claude-code')).toThrow(new RegExp(`${escapeRegex(target)} could not be replaced \\(EACCES\\)`));

    expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"dark"}');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });
});

describe.skipIf(ROOT)('a read-only settings.json', () => {
  it('is refused at once, as the in-place write was, not replaced by a rename or retried', () => {
    const file = seed();
    fs.chmodSync(file, 0o444);
    const started = Date.now();

    expect(() => installJsonHooks('claude-code')).toThrow(/EACCES|EPERM/);

    expect(Date.now() - started).toBeLessThan(500);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"dark"}');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  // A write that dies half way leaves its temp file; a stale read-only one at the temp name makes the temp write fail, so the file is written in place.
  it('removes the temp file when writing it fails, and writes the settings in place instead', () => {
    const file = seed();
    const tmp = `${fs.realpathSync(file)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, 'stale', { mode: 0o444 });

    expect(installJsonHooks('claude-code').installedSessionEnd).toBe(true);

    expect(fs.existsSync(tmp)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionEnd).toHaveLength(1);
  });
});
