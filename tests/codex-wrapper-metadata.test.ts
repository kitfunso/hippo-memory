// The wrapper metadata is a file any process of the user can rewrite, so repair and uninstall must never move a file
// it names unless the installer could have written that name.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureCodexWrapperInstalled,
  resolveCodexWrapperPaths,
  uninstallCodexWrapper,
} from '../src/hooks/codex-wrapper.js';
import { withFakeHome, type FakeHomeHandle } from './_helpers/with-fake-home.js';

const LAUNCHER = process.platform === 'win32' ? 'codex.cmd' : 'codex';
const BACKUP = process.platform === 'win32' ? 'codex.hippo-real.cmd' : 'codex.hippo-real';

let env: FakeHomeHandle;
let bin: string;

beforeEach(() => {
  env = withFakeHome('hippo-codex-metadata-');
  bin = path.join(env.home, 'real-bin');
  fs.mkdirSync(bin, { recursive: true });
  vi.stubEnv('PATH', bin);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  env.cleanup();
});

function writeMetadata(fields: Record<string, string>): string {
  const { metadataPath } = resolveCodexWrapperPaths();
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({ installMode: 'same-path', logFile: 'x', installedAt: 'x', ...fields }));
  return metadataPath;
}

/** Metadata that would have the old uninstall rename `victim` onto `target`. */
function hostileMetadata() {
  const victim = path.join(env.home, 'notes.txt');
  const target = path.join(env.home, 'elsewhere', 'moved.txt');
  fs.writeFileSync(victim, 'keep me here');
  fs.writeFileSync(path.join(bin, LAUNCHER), 'real codex\n');
  const metadataPath = writeMetadata({
    originalCodexPath: target,
    realCodexPath: victim,
    commandPath: path.join(env.home, 'nothing-here'),
    backupPath: victim,
  });
  return { victim, target, metadataPath };
}

describe('codex wrapper metadata hippo never wrote', () => {
  it('makes the repair a logged no-op that moves no file and keeps the record', () => {
    const { victim, target, metadataPath } = hostileMetadata();

    expect(ensureCodexWrapperInstalled().status).toBe('foreign-metadata');
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me here');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(bin, LAUNCHER), 'utf8')).toBe('real codex\n');
    expect(fs.existsSync(metadataPath)).toBe(true);
  });

  it('lets uninstall drop the record without moving the files it names', () => {
    const { victim, target, metadataPath } = hostileMetadata();

    uninstallCodexWrapper();

    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me here');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(metadataPath)).toBe(false);
  });

  it('refuses a launcher name the installer never records, even in the plan shape', () => {
    const original = path.join(bin, 'notes.txt');
    const backup = path.join(bin, 'notes.hippo-real.txt');
    fs.writeFileSync(backup, 'some other file');
    writeMetadata({ originalCodexPath: original, realCodexPath: backup, commandPath: original, backupPath: backup });

    expect(ensureCodexWrapperInstalled().status).toBe('foreign-metadata');
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(backup, 'utf8')).toBe('some other file');
  });
});

describe('a Codex update that put its launcher back over the wrapper', () => {
  function optInThenUpdate(): string {
    const launcher = path.join(bin, LAUNCHER);
    fs.writeFileSync(launcher, 'old codex\n');
    expect(ensureCodexWrapperInstalled().status).toBe('installed');
    fs.writeFileSync(launcher, 'updated codex\n');
    return launcher;
  }

  it('repairs around the updated launcher, never the stale backup', () => {
    const launcher = optInThenUpdate();

    expect(ensureCodexWrapperInstalled().status).toBe('installed');
    expect(fs.readFileSync(launcher, 'utf8')).toContain('codex-run');
    expect(fs.readFileSync(path.join(bin, BACKUP), 'utf8')).toBe('updated codex\n');
  });

  it('uninstall leaves the updated launcher in place', () => {
    const launcher = optInThenUpdate();

    uninstallCodexWrapper();

    expect(fs.readFileSync(launcher, 'utf8')).toBe('updated codex\n');
  });
});
