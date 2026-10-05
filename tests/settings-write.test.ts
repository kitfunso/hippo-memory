// How hippo replaces settings.json when another program holds it, it is read-only, or the temp file cannot be written.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/** A child that opens `file` and keeps it open for `ms`; resolves once the file is held. */
async function holdOpen(file: string, ms: number) {
  const script = `const fs = require('fs'); const fd = fs.openSync(process.argv[1], 'r'); console.log('held'); setTimeout(() => fs.closeSync(fd), ${ms});`;
  const child = spawn(process.execPath, ['-e', script, file], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  return child;
}

describe.skipIf(!WINDOWS)('a settings.json another program has open (Windows refuses a rename onto it)', () => {
  it('waits for the program to let go, then writes', async () => {
    const file = seed();
    const holder = await holdOpen(file, 300);

    expect(installJsonHooks('claude-code').installedSessionEnd).toBe(true);

    await once(holder, 'exit');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionEnd).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['settings.json']);
  });

  it('gives up after about a second with an error that names the file, and leaves no temp file', async () => {
    const file = seed();
    const holder = await holdOpen(file, 10_000);
    const started = Date.now();

    try {
      expect(() => installJsonHooks('claude-code')).toThrow(new RegExp(`${escapeRegex(fs.realpathSync(file))}.*in use`));
    } finally {
      holder.kill();
      await once(holder, 'exit');
    }

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
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

  // A write that dies half way leaves its temp file; a stale read-only one at the temp name makes the write fail the same way.
  it('removes the temp file when writing it fails', () => {
    const file = seed();
    const tmp = `${fs.realpathSync(file)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, 'stale', { mode: 0o444 });

    expect(() => installJsonHooks('claude-code')).toThrow(/EACCES|EPERM/);

    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"dark"}');
  });
});
