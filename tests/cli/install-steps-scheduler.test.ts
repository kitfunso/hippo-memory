// The daily-runner install reaches schtasks and crontab as argv with no shell between; a stand-in runner records the calls, so no real scheduler runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { setupDailySchedule } from '../../src/cli/install-steps.js';
import { DAILY_TASK_NAME } from '../../src/cli/scheduler.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly opts: ExecFileSyncOptionsWithStringEncoding;
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function scheduleOn(name: NodeJS.Platform, globalRoot: string): Call[] {
  Object.defineProperty(process, 'platform', { ...platform, value: name });
  const calls: Call[] = [];
  setupDailySchedule(globalRoot, (file, args, opts) => {
    calls.push({ file, args, opts });
    return '';
  });
  return calls;
}

describe('setupDailySchedule', () => {
  beforeEach(() => {
    vi.stubEnv('HIPPO_SKIP_SCHEDULE', undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks();
  });

  it('on Windows queries and creates the task through schtasks argv, never a shell command line', () => {
    const calls = scheduleOn('win32', 'C:/hippo-home');
    expect(calls.map(({ file, args }) => [file, args.slice(0, 3)])).toEqual([
      ['schtasks', ['/query', '/tn', DAILY_TASK_NAME]],
      ['schtasks', ['/create', '/tn', DAILY_TASK_NAME]],
    ]);
    expect(calls.every(({ opts }) => opts.shell === undefined && opts.stdio === 'pipe')).toBe(true);
  });

  // A Windows host resolves the root with backslashes, which the crontab branch refuses, so this case runs on POSIX hosts (CI) only.
  it.skipIf(process.platform === 'win32')('on Linux reads and writes the crontab through crontab argv, never a shell command line', () => {
    const calls = scheduleOn('linux', '/srv/hippo-home');
    expect(calls.map(({ file, args }) => [file, args])).toEqual([
      ['crontab', ['-l']],
      ['crontab', ['-']],
    ]);
    expect(calls[1]!.opts.input).toContain(`# hippo:${DAILY_TASK_NAME}`);
    expect(calls.every(({ opts }) => opts.shell === undefined && opts.stdio === 'pipe')).toBe(true);
  });
});
