import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openInBrowser } from '../src/cli/open-browser.js';
import { log } from '../src/util/log.js';

describe('graph view --open', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('warns and exits non-zero when the launcher cannot start', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const launcher = Object.assign(new EventEmitter(), { unref: () => {} });
    try {
      openInBrowser('g.html', () => launcher);
      launcher.emit('error', new Error('spawn xdg-open ENOENT'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not open the browser'));
      expect(process.exitCode).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
