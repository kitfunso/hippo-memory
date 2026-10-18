// requireInit stops its verb by throwing CliExit, so a caller or a test can catch it and runCli still sets the exit code.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliExit } from '../../src/cli/exit.js';
import { requireInit } from '../../src/cli/shared.js';
import { makeRoot } from '../_helpers/make-root.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requireInit', () => {
  it('throws CliExit with code 1 after printing the no-store message, without ending the process', () => {
    const root = makeRoot('require-init', { init: false });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit was called');
    });
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {});

    let thrown: unknown;
    try {
      requireInit(root);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliExit);
    expect(thrown).toMatchObject({ code: 1 });
    expect(exit).not.toHaveBeenCalled();
    expect(String(errs.mock.calls[0]?.[0])).toMatch(/^No hippo store at .*\. Run `hippo init` first\.$/);
  });

  it('returns for an initialised store', () => {
    const root = makeRoot('require-init-ok');
    expect(() => requireInit(root)).not.toThrow();
  });
});
