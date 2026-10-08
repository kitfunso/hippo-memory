// HIPPO_LOG picks the stderr threshold; the timestamp and fields such as the request id ride on the same line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatLogLine, isLevelEnabled, log, logThreshold, resetLogOnce } from '../src/log.js';
import { runWithRequestId } from '../src/util/request-scope.js';

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
