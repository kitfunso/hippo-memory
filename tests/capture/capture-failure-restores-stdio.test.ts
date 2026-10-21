// A failed capture sets the exit code and returns, so the log tee is undone instead of dying inside process.exit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runCapture } from '../../src/surface/capture/command.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';

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

describe('runCapture failure', () => {
  it.each([
    ['a missing file', (): string => (initTestStore(path.join(dir, '.hippo')), path.join(dir, '.hippo'))],
    ['an uninitialised store', (): string => path.join(dir, 'no-store')],
  ])('restores stdio and sets exit code 1 for %s', async (_name, makeRoot) => {
    const root = makeRoot();
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = path.join(dir, 'tee.log');
    await expect(
      runCapture(captureTarget(root), {
        tenantId: 'default',
        source: 'file',
        filePath: path.join(dir, 'absent.md'),
        logFile: log,
        dryRun: false,
        global: false,
      }),
    ).resolves.toBeUndefined();
    expect(errs).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.stdout.write('after-capture-marker');
    expect(fs.readFileSync(log, 'utf8')).not.toContain('after-capture-marker');
  });
});
