// HIPPO_LOG picks the stderr threshold; the timestamp and fields such as the request id ride on the same line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatLogLine, isLevelEnabled, log, logThreshold, resetLogOnce } from '../src/util/log.js';
import { runWithRequestId } from '../src/util/request-scope.js';
import { ownStderr } from './_helpers/own-stderr.js';

const AT = '2026-01-02T03:04:05.678Z';

let saved: string | undefined;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function lines(): string[] {
  return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0]));
}

beforeEach(() => {
  saved = process.env.HIPPO_LOG;
  delete process.env.HIPPO_LOG;
  vi.stubEnv('HIPPO_LOG_FORMAT', '');
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  resetLogOnce();
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (saved === undefined) delete process.env.HIPPO_LOG;
  else process.env.HIPPO_LOG = saved;
});

describe('log level filtering', () => {
  it('defaults to warn: error and warn print, info and debug do not', () => {
    expect(logThreshold()).toBe('warn');
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(lines()).toEqual([`[hippo] error: e ts=${AT}\n`, `[hippo] warn: w ts=${AT}\n`]);
  });

  it('HIPPO_LOG=debug prints every level, case-insensitively', () => {
    process.env.HIPPO_LOG = ' DEBUG ';
    log.info('i');
    log.debug('d');
    expect(lines()).toEqual([`[hippo] info: i ts=${AT}\n`, `[hippo] debug: d ts=${AT}\n`]);
  });

  it('HIPPO_LOG=error drops warnings', () => {
    process.env.HIPPO_LOG = 'error';
    log.warn('w');
    log.error('e');
    expect(lines()).toEqual([`[hippo] error: e ts=${AT}\n`]);
    expect(isLevelEnabled('warn')).toBe(false);
  });

  it('an unknown HIPPO_LOG value falls back to warn', () => {
    process.env.HIPPO_LOG = 'verbose';
    expect(logThreshold()).toBe('warn');
    expect(isLevelEnabled('info')).toBe(false);
  });

  it('once prints a key a single time per process', () => {
    log.once('k', 'warn', 'first');
    log.once('k', 'warn', 'second');
    log.once('other', 'warn', 'third');
    expect(lines()).toEqual([`[hippo] warn: first ts=${AT}\n`, `[hippo] warn: third ts=${AT}\n`]);
  });

  it('caps the once-only keys at 1,000: the next new key writes one cap line, and new keys then log at debug unrecorded', () => {
    process.env.HIPPO_LOG = 'debug';
    for (let i = 0; i < 1_000; i++) log.warnThenDebug(`row-${i}`, `damaged ${i}`);
    expect(lines().filter((line) => line.startsWith('[hippo] warn: damaged '))).toHaveLength(1_000);
    expect(lines()).toHaveLength(1_000);
    stderrSpy.mockClear();

    log.warnThenDebug('row-1000', 'damaged 1000');
    log.warnThenDebug('row-1001', 'damaged 1001');
    log.once('row-1002', 'warn', 'once past the cap');
    log.once('row-1002', 'warn', 'once past the cap');
    log.warnThenDebug('row-0', 'damaged 0');
    log.once('row-0', 'warn', 'a recorded key');
    expect(lines()).toEqual([
      `[hippo] warn: log: 1000 once-only warnings were written; further new ones in this process log at debug ts=${AT}\n`,
      `[hippo] debug: damaged 1000 ts=${AT}\n`,
      `[hippo] debug: damaged 1001 ts=${AT}\n`,
      // The set did not grow: a recorded key would have dropped the second call, as it does for row-0 below.
      `[hippo] debug: once past the cap ts=${AT}\n`,
      `[hippo] debug: once past the cap ts=${AT}\n`,
      `[hippo] debug: damaged 0 ts=${AT}\n`,
    ]);
    stderrSpy.mockClear();

    resetLogOnce();
    log.warnThenDebug('row-1000', 'damaged 1000');
    expect(lines()).toEqual([`[hippo] warn: damaged 1000 ts=${AT}\n`]);
  });
});

describe('log fields', () => {
  it('appends the request id and other fields as key=value, skipping undefined', () => {
    expect(formatLogLine('warn', 'boom', { requestId: 'abc-123', status: 503, extra: undefined }))
      .toBe('[hippo] warn: boom requestId=abc-123 status=503');
  });

  it('flattens newlines so one event stays on one line', () => {
    expect(formatLogLine('error', 'a\nb', { requestId: 'x\r\ny' })).toBe('[hippo] error: a b requestId=x y');
  });

  it('HIPPO_LOG_FORMAT=json writes the same fields as one JSON object per line', () => {
    vi.stubEnv('HIPPO_LOG_FORMAT', 'json');
    runWithRequestId('req-7', () => log.warn('a\nb', { status: 503 }));
    expect(lines().map((line) => JSON.parse(line))).toEqual([{ ts: AT, level: 'warn', msg: 'a\nb', requestId: 'req-7', status: 503 }]);
    expect(lines()[0].endsWith('}\n')).toBe(true);
  });
});

describe('a command that fails at the top level', () => {
  it('prints only the message by default, and adds the error class and stack under HIPPO_LOG=debug', () => {
    vi.useRealTimers();
    const dir = mkdtempSync(join(tmpdir(), 'hippo-cli-top-error-'));
    try {
      // A store file that is not a database makes the first read throw past every verb.
      mkdirSync(join(dir, '.hippo'));
      writeFileSync(join(dir, '.hippo', 'hippo.db'), 'x'.repeat(4096));
      const run = (level: string) => spawnSync(process.execPath, [resolve('dist', 'cli.js'), 'recall', 'anything'], {
        cwd: dir,
        env: { ...process.env, HIPPO_HOME: join(dir, 'home'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1', HIPPO_LOG: level, HIPPO_LOG_FORMAT: '' },
        encoding: 'utf8',
      });

      const plain = run('warn');
      expect([plain.status, ownStderr(plain.stderr)]).toEqual([1, 'Error: file is not a database\n']);

      const debug = run('debug');
      expect(debug.status).toBe(1);
      expect(ownStderr(debug.stderr)).toMatch(/Error: file is not a database\n {2}thrown as Error\nError: file is not a database\n\s+at /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
