// How hippo replaces settings.json when another program holds it, it is read-only, the rename is refused, or the temp file cannot be written;
// and that the other config files it rewrites go through the same replace.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escapeRegex } from '../src/escape.js';
import { installCopilot } from '../src/hooks/copilot.js';
import { installJsonHooks, resolveJsonHookPaths } from '../src/hooks/json-hooks.js';
import { installOpencodePlugin } from '../src/hooks/opencode.js';
import { registerWorkspace, workspaceRegistryPath } from '../src/scheduler.js';
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
    // A retry pauses between renames, so no pause means no retry, however slow the runner.
    const pause = vi.spyOn(Atomics, 'wait');
    try {
      expect(() => installJsonHooks('claude-code')).toThrow(/EACCES|EPERM/);
      expect(pause).not.toHaveBeenCalled();
    } finally {
      pause.mockRestore();
    }

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

interface Rewrite {
  readonly file: string;
  readonly rewrite: () => void;
}

function seedFile(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

const OTHER_CONFIG_FILES: ReadonlyArray<readonly [string, (home: string) => Rewrite]> = [
  ['opencode.json', (home) => ({
    file: seedFile(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
      theme: 'dark',
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo session-end --log-file foo', timeout: 5 }] }] },
    }, null, 2)),
    rewrite: () => { installOpencodePlugin(); },
  })],
  ['the workspace registry', (home) => {
    const globalRoot = path.join(home, '.hippo');
    registerWorkspace(globalRoot, path.join(home, 'repo-a'));
    return { file: workspaceRegistryPath(globalRoot), rewrite: () => { registerWorkspace(globalRoot, path.join(home, 'repo-b')); } };
  }],
  ['copilot-instructions.md', (home) => {
    // A first install leaves the hooks and MCP files current, so the rerun's only write is the instructions file.
    fs.mkdirSync(path.join(home, '.copilot'));
    const file = seedFile(installCopilot().paths.instructions, '# House rules\n\nAlways run the linter before a commit.\n');
    return { file, rewrite: () => { installCopilot(); } };
  }],
];

describe('a write that dies halfway, as on a full disk', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  it.each(OTHER_CONFIG_FILES)('%s keeps its old bytes and gains no temp file', (_name, arrange) => {
    const { file, rewrite } = arrange(env.home);
    const before = fs.readFileSync(file, 'utf8');
    // Stubbed because no real fault stops a write midway on demand: each write lands its first half, then fails.
    const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((dest, data, options) => {
      const text = String(data);
      write(dest, text.slice(0, Math.ceil(text.length / 2)), options);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    syncBuiltinESMExports();

    expect(rewrite).toThrow(/ENOSPC/);

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
