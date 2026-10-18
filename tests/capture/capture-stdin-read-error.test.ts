// A failed stdin read keeps its cause in the log; the printed advice and the exit code stay as they were.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdCapture } from '../../src/capture/command.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';

let savedExitCode: typeof process.exitCode;
beforeEach(() => {
  savedExitCode = process.exitCode;
});
afterEach(() => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

describe('cmdCapture reading stdin', () => {
  it('logs the error that stopped the read, then prints the usual advice and sets exit code 1', () => {
    const root = makeRoot('capture-stdin');
    const target = captureTarget(root);
    // The stdin read is the first readFileSync cmdCapture makes, so the one failure lands on it.
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, read'), { code: 'EAGAIN' });
    });
    syncBuiltinESMExports();
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    cmdCapture(target, { tenantId: 'default', source: 'stdin', dryRun: true, global: false });

    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('reading stdin failed: EAGAIN');
    expect(read).toHaveBeenCalledWith(0, 'utf8');
    expect(errs).toHaveBeenCalledWith('No input on stdin. Pipe text in or use --file <path>.');
    expect(process.exitCode).toBe(1);
  });
});
