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

function scheduleOn(
  name: NodeJS.Platform,
  globalRoot: string,
  answer: (args: readonly string[]) => string = () => '',
): Call[] {
  Object.defineProperty(process, 'platform', { ...platform, value: name });
  const calls: Call[] = [];
  setupDailySchedule(globalRoot, (file, args, opts) => {
    calls.push({ file, args, opts });
    return answer(args);
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

  describe('on Windows when the task query does not succeed', () => {
    const said = (): string[] => vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    const queryFailing = (err: Error) => (args: readonly string[]) => {
      if (args[0] === '/query') throw err;
      return '';
    };

    it('stops without creating the task when schtasks /query times out, and says so in one line', () => {
      const timedOut = Object.assign(new Error('spawnSync schtasks ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const calls = scheduleOn('win32', 'C:/hippo-home', queryFailing(timedOut));
      expect(calls.map(({ args }) => args[0])).toEqual(['/query']);
      expect(said()).toEqual([
        `   schtasks /query did not answer within 30 s and was stopped, so Task Scheduler was not changed; run hippo ` +
          `init again, or check for the task ${DAILY_TASK_NAME}.`,
      ]);
    });

    it('creates the task when schtasks /query fails because the task does not exist', () => {
      const calls = scheduleOn('win32', 'C:/hippo-home', queryFailing(exitedWith(1, 'ERROR: cannot find the task')));
      expect(calls.map(({ args }) => args[0])).toEqual(['/query', '/create']);
      expect(said().join(' | ')).toContain('Scheduled machine-level daily runner');
    });

    it('leaves a task that already exists alone', () => {
      const calls = scheduleOn('win32', 'C:/hippo-home', (args) => (args[0] === '/query' ? DAILY_TASK_NAME : ''));
      expect(calls.map(({ args }) => args[0])).toEqual(['/query']);
      expect(said()).toEqual([]);
    });
  });
});

/** What node's execFileSync throws for a program that exits non-zero with `stderr` on its error stream. */
function exitedWith(status: number, stderr: string): Error {
  return Object.assign(new Error(`Command failed: crontab -l\n${stderr}`), { status, stderr });
}

const MARKER = `# hippo:${DAILY_TASK_NAME}`;
const CMD = 'cd "/srv/hippo-home" && hippo daily-runner';

/** Runs the install on a Linux host whose `crontab -l` answers `listing`; a `crontab -` write throws `writeError`. */
function install(listing: Error | string, writeError?: Error): Call[] {
  const calls: Call[] = [];
  setupDailySchedule(
    '/srv/hippo-home',
    (file, args, opts) => {
      calls.push({ file, args, opts });
      if (args[0] === '-l') {
        if (listing instanceof Error) throw listing;
        return listing;
      }
      if (writeError !== undefined) throw writeError;
      return '';
    },
    'linux',
  );
  return calls;
}

describe('setupDailySchedule on a user with no crontab yet', () => {
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
    expect(install(`15 6 * * * ${CMD} ${MARKER}\n`).map(({ args }) => args)).toEqual([['-l']]);
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

describe('setupDailySchedule on a crontab that may already hold the daily runner', () => {
  const STALE = 'cd "/old/home" && hippo daily-runner';
  const OTHER_LINES = 'MAILTO=me\n# nightly jobs\n0 3 * * * /usr/bin/backup  \n\n0 5 * * 1 /usr/bin/weekly\n';
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

  /** The crontab text the install wrote, or undefined when it wrote nothing. */
  const written = (calls: Call[]): string | undefined =>
    calls.find(({ args }) => args[0] === '-')?.opts.input?.toString();

  it('writes nothing when an active line already carries the current command and the marker', () => {
    const calls = install(`15 6 * * * ${CMD} ${MARKER}\n`);
    expect(calls.map(({ args }) => args)).toEqual([['-l']]);
    expect(said).toEqual([]);
  });

  it('does not add a second entry when a comment follows the marker or text comes after it', () => {
    for (const tail of ['# keep', '>> /var/log/hippo.log']) {
      const calls = install(`15 6 * * * ${CMD} ${MARKER} ${tail}\n`);
      expect(calls.map(({ args }) => args)).toEqual([['-l']]);
    }
  });

  it('appends the entry after unrelated lines and keeps those lines byte for byte', () => {
    expect(written(install(OTHER_LINES))).toBe(`${OTHER_LINES}15 6 * * * ${CMD} ${MARKER}\n`);
  });

  it('adds an entry when the marker only appears on a commented-out line', () => {
    const commented = `# 15 6 * * * ${CMD} ${MARKER}\n`;
    expect(written(install(commented))).toBe(`${commented}15 6 * * * ${CMD} ${MARKER}\n`);
  });

  it('adds an entry when the only marker line carries a longer name', () => {
    const longer = `15 6 * * * ${CMD} ${MARKER}-old\n`;
    expect(written(install(longer))).toBe(`${longer}15 6 * * * ${CMD} ${MARKER}\n`);
  });

  it('rewrites a stale command in place, keeps the schedule and the other lines, and says what changed', () => {
    const old = `30 4 * * * ${STALE} ${MARKER}`;
    const calls = install(`${OTHER_LINES}${old}\n@reboot /usr/bin/noop\n`);
    const fresh = `30 4 * * * ${CMD} ${MARKER}`;
    expect(written(calls)).toBe(`${OTHER_LINES}${fresh}\n@reboot /usr/bin/noop\n`);
    expect(written(calls)!.split(MARKER)).toHaveLength(2);
    expect(said).toContain(`   was: ${old}`);
    expect(said).toContain(`   now: ${fresh}`);
  });

  it('keeps an @macro schedule when it rewrites the command', () => {
    expect(written(install(`@daily ${STALE} ${MARKER}\n`))).toBe(`@daily ${CMD} ${MARKER}\n`);
  });

  it('keeps the text after the marker when it rewrites the command', () => {
    expect(written(install(`30 4 * * * ${STALE} ${MARKER} # keep me\n`))).toBe(
      `30 4 * * * ${CMD} ${MARKER} # keep me\n`,
    );
  });

  it('matches a marked line that ends in spaces or CRLF and keeps CRLF line endings', () => {
    expect(install(`MAILTO=me\r\n15 6 * * * ${CMD} ${MARKER}  \r\n`).map(({ args }) => args)).toEqual([['-l']]);
    const calls = install(`MAILTO=me\r\n30 4 * * * ${STALE} ${MARKER}  \r\n`);
    expect(written(calls)).toBe(`MAILTO=me\r\n30 4 * * * ${CMD} ${MARKER}  \r\n`);
  });

  it('collapses two active marked lines into one and names the line it removed', () => {
    const second = `0 1 * * * ${CMD} ${MARKER}`;
    const calls = install(`15 6 * * * ${CMD} ${MARKER}\nMAILTO=me\n${second}\n`);
    expect(written(calls)).toBe(`15 6 * * * ${CMD} ${MARKER}\nMAILTO=me\n`);
    expect(said).toContain('   Removed a duplicate daily runner entry from your crontab:');
    expect(said).toContain(`   ${second}`);
  });

  it('leaves a marked line it cannot read as a schedule alone and logs a warning', () => {
    const calls = install(`MAILTO=me ${MARKER}\n`);
    expect(calls.map(({ args }) => args)).toEqual([['-l']]);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('is not a cron schedule');
  });

  it('prints a manual line that ends with the marker when the crontab cannot be written', () => {
    install('', new Error('crontab: you are not allowed to use this program'));
    expect(said).toContain(`   15 6 * * * ${CMD} ${MARKER}`);
  });

  // Another job that only holds the marker as quoted data is not our entry, whatever its schedule.
  const BACKUP_JOB = `0 0 * * * crontab -l | grep -v ' ${MARKER} ' > /tmp/cron.bak`;
  const ECHO_JOB = `0 1 * * * echo "kept ${MARKER} here"`;

  it('keeps a real entry and leaves a job that only quotes the marker alone', () => {
    for (const quoting of [BACKUP_JOB, ECHO_JOB]) {
      const entry = `15 6 * * * ${CMD} ${MARKER}`;
      expect(install(`${quoting}\n${entry}\n`).map(({ args }) => args)).toEqual([['-l']]);
      expect(install(`${entry}\n${quoting}\n`).map(({ args }) => args)).toEqual([['-l']]);
    }
  });

  it('recognises its own entry when the runner folder holds an apostrophe', () => {
    const run = (root: string, listing: string): Call[] => {
      const calls: Call[] = [];
      const exec = (file: string, args: readonly string[], opts: Call['opts']): string => {
        calls.push({ file, args, opts });
        return args[0] === '-l' ? listing : '';
      };
      setupDailySchedule(root, exec, 'linux');
      return calls;
    };
    for (const root of ["/srv/keith's/.hippo"]) {
      const entry = written(run(root, '')) ?? '';
      expect(run(root, entry).map(({ args }) => args)).toEqual([['-l']]);
    }
  });

  it('adds an entry when the only marker is inside quotes in another job', () => {
    for (const quoting of [BACKUP_JOB, ECHO_JOB]) {
      expect(written(install(`MAILTO=me\n${quoting}\n`))).toBe(`MAILTO=me\n${quoting}\n15 6 * * * ${CMD} ${MARKER}\n`);
    }
  });

  it('rewrites only the real entry when a stale one sits beside a job that quotes the marker', () => {
    const calls = install(`${BACKUP_JOB}\n30 4 * * * ${STALE} ${MARKER}\n${ECHO_JOB}\n`);
    expect(written(calls)).toBe(`${BACKUP_JOB}\n30 4 * * * ${CMD} ${MARKER}\n${ECHO_JOB}\n`);
    expect(said.some((line) => line.includes('Removed a duplicate'))).toBe(false);
  });
});
