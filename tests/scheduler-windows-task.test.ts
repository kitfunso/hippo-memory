import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDailyRunnerCommand, buildSchtasksCreateArgs, buildWindowsTaskRun, quoteInsideWindowsArg } from '../src/cli/scheduler.js';

describe('Windows daily task', () => {
  it('runs the runner under a headless console', () => {
    const cmd = buildDailyRunnerCommand('C:/Users/me/.hippo', 'win32');
    expect(buildWindowsTaskRun(cmd)).toBe(`conhost.exe --headless cmd /c ${cmd}`);
    expect(buildSchtasksCreateArgs('t', cmd)).toContain(`conhost.exe --headless cmd /c ${cmd}`);
  });

  it('keeps a quoted command inside one argument when a backslash sits before a quote or the end', () => {
    expect(quoteInsideWindowsArg('cd "C:/a b" && hippo')).toBe('cd \\"C:/a b\\" && hippo');
    expect(quoteInsideWindowsArg('cd "C:\\a\\" && x\\')).toBe('cd \\"C:\\a\\\\\\" && x\\\\');
    expect(quoteInsideWindowsArg('C:\\a\\b')).toBe('C:\\a\\b');
  });

  // It creates and runs a real scheduled task, so only on a throwaway CI machine, never a developer's.
  it.skipIf(process.platform !== 'win32' || !process.env.CI)('creates a task whose quoted && command runs intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hippo sched '));
    const name = `hippo-test-headless-${process.pid}`;
    const schtasks = (...args: string[]) => execFileSync('schtasks', args, { encoding: 'utf-8', windowsHide: true });
    let created = false;
    try {
      schtasks(...buildSchtasksCreateArgs(name, `cd /d "${dir}" && echo ran> out.txt`));
      created = true;
      expect(schtasks('/query', '/tn', name, '/xml')).toContain('<Command>conhost.exe</Command>');
      schtasks('/run', '/tn', name);
      const out = join(dir, 'out.txt');
      for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 200));
      expect(readFileSync(out, 'utf8').trim()).toBe('ran');
    } finally {
      if (created) schtasks('/delete', '/tn', name, '/f');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
