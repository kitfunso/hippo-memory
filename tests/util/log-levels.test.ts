// HIPPO_LOG picks the stderr threshold; the timestamp and fields such as the request id ride on the same line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorFields, formatLogLine, isLevelEnabled, log } from '../../src/base/util/log.js';
import { runWithRequestId } from '../../src/base/util/request-scope.js';
import { ownStderr } from '../_helpers/own-stderr.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runCliAs } from '../_helpers/run-cli-as.js';

const AT = '2026-01-02T03:04:05.678Z';
let stderrSpy: ReturnType<typeof vi.spyOn>;

/** The logger of a fresh module graph, whose once-only keys start empty as a new process's do. */
async function freshLog() {
  vi.resetModules();
  const [logModule, storedJson] = await Promise.all([
    import('../../src/base/util/log.js'),
    import('../../src/base/util/stored-json.js'),
  ]);
  return { log: logModule.log, warnDamagedColumn: storedJson.warnDamagedColumn };
}

function lines(): string[] {
  return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0]));
}

beforeEach(() => {
  vi.stubEnv('HIPPO_LOG', undefined);
  vi.stubEnv('HIPPO_LOG_FORMAT', '');
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(AT) });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('log level filtering', () => {
  it('defaults to warn: error and warn print, info and debug do not', () => {
    expect([isLevelEnabled('warn'), isLevelEnabled('info')]).toEqual([true, false]);
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(lines()).toEqual([`[hippo] error: e ts=${AT}\n`, `[hippo] warn: w ts=${AT}\n`]);
  });

  it('HIPPO_LOG=debug prints every level, case-insensitively', () => {
    vi.stubEnv('HIPPO_LOG', ' DEBUG ');
    log.info('i');
    log.debug('d');
    expect(lines()).toEqual([`[hippo] info: i ts=${AT}\n`, `[hippo] debug: d ts=${AT}\n`]);
  });

  it('HIPPO_LOG=error drops warnings', () => {
    vi.stubEnv('HIPPO_LOG', 'error');
    log.warn('w');
    log.error('e');
    expect(lines()).toEqual([`[hippo] error: e ts=${AT}\n`]);
    expect(isLevelEnabled('warn')).toBe(false);
  });

  it('an unknown HIPPO_LOG value falls back to warn', () => {
    vi.stubEnv('HIPPO_LOG', 'verbose');
    expect([isLevelEnabled('warn'), isLevelEnabled('info')]).toEqual([true, false]);
  });

  it('once prints a key a single time per process', async () => {
    const { log } = await freshLog();
    log.once('k', 'warn', 'first');
    log.once('k', 'warn', 'second');
    log.once('other', 'warn', 'third');
    expect(lines()).toEqual([`[hippo] warn: first ts=${AT}\n`, `[hippo] warn: third ts=${AT}\n`]);
  });

  it('caps the once-only keys at 1,000: the next new key writes one cap line, and new keys then log at debug unrecorded', async () => {
    const { log } = await freshLog();
    vi.stubEnv('HIPPO_LOG', 'debug');
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

    const nextProcess = await freshLog();
    nextProcess.log.warnThenDebug('row-1000', 'damaged 1000');
    expect(lines()).toEqual([`[hippo] warn: damaged 1000 ts=${AT}\n`]);
  });
});

describe('damaged column warnings', () => {
  it('spend one once-key on 2,000 damaged rows of one column, so a later failure class still logs at warn', async () => {
    const { log, warnDamagedColumn } = await freshLog();
    vi.stubEnv('HIPPO_LOG', 'warn');
    for (let row = 0; row < 2_000; row++) {
      warnDamagedColumn({ table: 'memories', id: `m${row}`, column: 'tags_json' }, 'not valid JSON');
    }
    log.warnThenDebug('a-new-failure-class', 'a failure of another class');
    expect(lines()).toEqual([
      `[hippo] warn: store: memories.tags_json is not valid JSON; read as empty ts=${AT} table=memories id=m0 column=tags_json\n`,
      `[hippo] warn: a failure of another class ts=${AT}\n`,
    ]);
  });
});

describe('warnThenSample', () => {
  it('warns on the first failure, then again with the count on every 100th', async () => {
    const { log } = await freshLog();
    vi.stubEnv('HIPPO_LOG', 'warn');
    for (let i = 0; i < 250; i++) log.warnThenSample('fts-sync', 'FTS update failed');
    expect(lines()).toEqual([
      `[hippo] warn: FTS update failed ts=${AT}
`,
      `[hippo] warn: FTS update failed (100 more since the first warning) ts=${AT}
`,
      `[hippo] warn: FTS update failed (200 more since the first warning) ts=${AT}
`,
    ]);
  });
});

describe('log fields', () => {
  it('appends the request id and other fields as key=value, skipping undefined', () => {
    expect(formatLogLine('warn', 'boom', { requestId: 'abc-123', status: 503, extra: undefined })).toBe(
      '[hippo] warn: boom requestId=abc-123 status=503',
    );
  });

  it('flattens newlines so one event stays on one line', () => {
    expect(formatLogLine('error', 'a\nb', { requestId: 'x\r\ny' })).toBe('[hippo] error: a b requestId=x y');
  });

  it('HIPPO_LOG_FORMAT=json writes the same fields as one JSON object per line', () => {
    vi.stubEnv('HIPPO_LOG_FORMAT', 'json');
    runWithRequestId('req-7', () => log.warn('a\nb', { status: 503 }));
    expect(lines().map((line) => JSON.parse(line))).toEqual([
      { ts: AT, level: 'warn', msg: 'a\nb', requestId: 'req-7', status: 503 },
    ]);
    expect(lines()[0].endsWith('}\n')).toBe(true);
  });
});

describe('errorFields cause chain', () => {
  it('lists each cause as class: message, five deep at most', () => {
    let err = new Error('e0');
    for (let i = 1; i <= 7; i++) err = new Error(`e${i}`, { cause: err });
    expect(errorFields(err).cause).toBe('Error: e6 <- Error: e5 <- Error: e4 <- Error: e3 <- Error: e2');
  });

  it('has no cause field for an error without one, names a non-Error cause, and stops at a cycle', () => {
    expect(errorFields(new Error('plain')).cause).toBeUndefined();
    expect(errorFields(new Error('top', { cause: 'text' })).cause).toBe('NonError: text');
    const a = new TypeError('a');
    const b = new RangeError('b', { cause: a });
    a.cause = b;
    expect(errorFields(a).cause).toBe('RangeError: b');
  });
});

describe('a command that fails at the top level', () => {
  it('prints only the message by default, and adds the error class and stack under HIPPO_LOG=debug', async () => {
    vi.useRealTimers();
    const dir = makeRoot('cli-top-error', { init: false });
    // A store file that is not a database makes the first read throw past every verb.
    mkdirSync(join(dir, '.hippo'));
    writeFileSync(join(dir, '.hippo', 'hippo.db'), 'x'.repeat(4096));
    const run = (level: string) =>
      runCliAs(['recall', 'anything'], {
        cwd: dir,
        env: {
          ...process.env,
          HIPPO_HOME: join(dir, 'home'),
          HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
          HIPPO_LOG: level,
          HIPPO_LOG_FORMAT: '',
        },
      });

    const plain = await run('warn');
    expect([plain.status, ownStderr(plain.stderr)]).toEqual([1, 'Error: file is not a database\n']);

    const debug = await run('debug');
    expect(debug.status).toBe(1);
    expect(ownStderr(debug.stderr)).toMatch(
      /Error: file is not a database\n {2}thrown as Error\nError: file is not a database\n\s+at /,
    );
  });
});
