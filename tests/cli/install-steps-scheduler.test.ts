// The daily-runner install reaches schtasks and crontab as argv with no shell between; a stand-in runner records the calls, so no real scheduler runs.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { setupDailySchedule } from '../../src/surface/cli/install-steps.js';
import { DAILY_TASK_NAME } from '../../src/surface/cli/scheduler.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// The runner's options type is private to the module, so it is read off the parameter.
type SchedulerOptions = Parameters<NonNullable<Parameters<typeof setupDailySchedule>[1]>>[2];

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly opts: SchedulerOptions;
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
  it.skipIf(process.platform === 'win32')(
    'on Linux reads and writes the crontab through crontab argv, never a shell command line',
    () => {
      const calls = scheduleOn('linux', '/srv/hippo-home');
      expect(calls.map(({ file, args }) => [file, args])).toEqual([
        ['crontab', ['-l']],
        ['crontab', ['-']],
      ]);
      expect(calls[1]!.opts.input).toContain(`# hippo:${DAILY_TASK_NAME}`);
      expect(calls.every(({ opts }) => opts.shell === undefined && opts.stdio === 'pipe')).toBe(true);
    },
  );
});

/** What node's execFileSync throws for a program that exits non-zero with `stderr` on its error stream. */
function exitedWith(status: number, stderr: string): Error {
  return Object.assign(new Error(`Command failed: crontab -l\n${stderr}`), { status, stderr });
}

describe('setupDailySchedule on a user with no crontab yet', () => {
  const MARKER = `# hippo:${DAILY_TASK_NAME}`;
  const MANUAL = 'add to crontab (crontab -e)';
  let said: string[];
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    vi.stubEnv('HIPPO_SKIP_SCHEDULE', undefined);
    vi.stubEnv('HIPPO_LOG', 'warn');
    said = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      said.push(line);
    });
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Runs the install on a Linux host whose `crontab -l` fails with `listing`; every other call succeeds. */
  function install(listing: Error | string): Call[] {
    const calls: Call[] = [];
    setupDailySchedule(
      '/srv/hippo-home',
      (file, args, opts) => {
        calls.push({ file, args, opts });
        if (args[0] === '-l') {
          if (listing instanceof Error) throw listing;
          return listing;
        }
        return '';
      },
      'linux',
    );
    return calls;
  }

  it('installs the entry alone when crontab -l says "no crontab for <user>"', () => {
    const calls = install(exitedWith(1, 'no crontab for skf\n'));
    expect(calls.map(({ args }) => args)).toEqual([['-l'], ['-']]);
    expect(calls[1]!.opts.input).toBe(`15 6 * * * cd "/srv/hippo-home" && hippo daily-runner ${MARKER}\n`);
    expect(said.join('\n')).toContain('via crontab');
    expect(said.join('\n')).not.toContain(MANUAL);
  });

  it('appends to a crontab that exists, and leaves one that already holds the entry alone', () => {
    const appended = install('MAILTO=me\n');
    expect(appended[1]!.opts.input).toMatch(/^MAILTO=me\n15 6 \* \* \* /);
    expect(install(`15 6 * * * hippo daily-runner ${MARKER}\n`).map(({ args }) => args)).toEqual([['-l']]);
  });

  it('keeps the manual path and logs why, with the error fields, for any other failure', () => {
    const calls = install(exitedWith(1, 'crontab: you are not allowed to use this program\n'));
    expect(calls.map(({ args }) => args)).toEqual([['-l']]);
    expect(said.join('\n')).toContain(MANUAL);
    const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('crontab could not be read or written');
    expect(logged).toContain('errorClass=Error');
    expect(logged).toContain('stack=');
  });

  it('does not take another exit status that mentions the same words as a missing crontab', () => {
    const calls = install(exitedWith(2, 'no crontab for skf\n'));
    expect(calls.map(({ args }) => args)).toEqual([['-l']]);
    expect(said.join('\n')).toContain(MANUAL);
  });
});
