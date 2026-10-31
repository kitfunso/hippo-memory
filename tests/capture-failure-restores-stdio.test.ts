// A failed capture sets the exit code and returns, so the log tee is undone instead of dying inside process.exit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initStore } from '../src/store/open.js';
import { cmdCapture } from '../src/capture/command.js';

let dir: string;
let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-capture-fail-'));
  savedExitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cmdCapture failure', () => {
  it.each([
    ['a missing file', (): string => (initStore(path.join(dir, '.hippo')), path.join(dir, '.hippo'))],
    ['an uninitialised store', (): string => path.join(dir, 'no-store')],
  ])('restores stdio and sets exit code 1 for %s', (_name, makeRoot) => {
    const root = makeRoot();
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = path.join(dir, 'tee.log');
    expect(() => cmdCapture(root, {
      source: 'file', filePath: path.join(dir, 'absent.md'), logFile: log, dryRun: false, global: false,
    })).not.toThrow();
    expect(errs).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.stdout.write('after-capture-marker');
    expect(fs.readFileSync(log, 'utf8')).not.toContain('after-capture-marker');
  });
});
