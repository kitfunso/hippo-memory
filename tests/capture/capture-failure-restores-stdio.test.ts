// A failed capture sets the exit code and returns, so the log tee is undone instead of dying inside process.exit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { cmdCapture } from '../../src/capture/command.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initStore } from '../../src/store/sqlite/handles.js';

let dir: string;
let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  dir = makeRoot('capture-fail', { init: false });
  savedExitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
});

describe('cmdCapture failure', () => {
  it.each([
    ['a missing file', (): string => (initStore(path.join(dir, '.hippo')), path.join(dir, '.hippo'))],
    ['an uninitialised store', (): string => path.join(dir, 'no-store')],
  ])('restores stdio and sets exit code 1 for %s', (_name, makeRoot) => {
    const root = makeRoot();
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = path.join(dir, 'tee.log');
    expect(() =>
      cmdCapture(captureTarget(root), {
        tenantId: 'default',
        source: 'file',
        filePath: path.join(dir, 'absent.md'),
        logFile: log,
        dryRun: false,
        global: false,
      }),
    ).not.toThrow();
    expect(errs).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.stdout.write('after-capture-marker');
    expect(fs.readFileSync(log, 'utf8')).not.toContain('after-capture-marker');
  });
});
