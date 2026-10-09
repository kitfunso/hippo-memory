// `hippo init` against a fake crontab first on PATH: the real crontab is never reached.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hippoRun } from './_helpers/spawn-hippo.js';

const MARKER = '# hippo:hippo-daily-runner';
const FAKE_CRONTAB = [
  '#!/bin/sh',
  'echo "$1" >> "$FAKE_CRON_LOG"',
  'if [ "$1" = "-l" ]; then',
  '  [ -f "$FAKE_CRON_STATE" ] && cat "$FAKE_CRON_STATE"',
  '  exit 0',
  'fi',
  'cat > "$FAKE_CRON_STATE"',
  '',
].join('\n');

// crontab does not exist on Windows, and the fake is a shell script.
describe.skipIf(process.platform === 'win32')('hippo init installs the daily runner through crontab', () => {
  let tmp: string;
  let state: string;
  let log: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cron-'));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'crontab'), FAKE_CRONTAB, { mode: 0o755 });
    state = path.join(tmp, 'crontab.state');
    log = path.join(tmp, 'crontab.log');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function init(hippoHome: string) {
    const cwd = path.join(tmp, 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const r = hippoRun(['init', '--no-learn'], {
      cwd,
      env: {
        ...process.env,
        PATH: `${path.join(tmp, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
        HOME: tmp,
        USERPROFILE: tmp,
        HIPPO_HOME: hippoHome,
        FAKE_CRON_STATE: state,
        FAKE_CRON_LOG: log,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  }

  const calls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  const markerLines = (): string[] => fs.readFileSync(state, 'utf8').split('\n').filter((l) => l.includes(MARKER));

  it('writes one marked line, keeps an unrelated line, and adds nothing on a second run', () => {
    fs.writeFileSync(state, '0 1 * * * /usr/bin/true # unrelated\n');
    init(path.join(tmp, 'global'));
    expect(calls().length, 'the fake crontab was never called; the real one may have run').toBeGreaterThan(0);
    expect(markerLines()).toHaveLength(1);
    expect(markerLines()[0]).toContain('15 6 * * *');
    expect(fs.readFileSync(state, 'utf8')).toContain('# unrelated');

    init(path.join(tmp, 'global'));
    expect(markerLines()).toHaveLength(1);
  });

  it('skips the schedule and never writes when the store path holds a percent sign', () => {
    const out = init(path.join(tmp, 'pct%store'));
    expect(out).toContain('Skipping schedule: runner path contains unsafe characters.');
    expect(calls()).not.toContain('-');
    expect(fs.existsSync(state)).toBe(false);
  });
});
