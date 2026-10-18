import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { openInBrowser } from '../../src/cli/open-browser.js';
import { log } from '../../src/util/log.js';

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

  it('on Windows never hands cmd.exe a file name it would split into a second command', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const launches: string[][] = [];
    const launcher = Object.assign(new EventEmitter(), { unref: () => {} });
    try {
      openInBrowser('graph&calc.html', (cmd, args) => {
        launches.push([cmd, ...args]);
        return launcher;
      });
      openInBrowser('graph.html', (cmd, args) => {
        launches.push([cmd, ...args]);
        return launcher;
      });
      expect(launches).toEqual([['cmd', '/c', 'start', '', 'graph.html']]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('graph&calc.html'));
      expect(process.exitCode).toBe(1);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      warn.mockRestore();
    }
  });
});
