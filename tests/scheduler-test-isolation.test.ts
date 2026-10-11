// The suite sets HIPPO_SKIP_SCHEDULE, so a test that forgets --no-schedule still cannot reach the real schtasks or crontab.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hippoRun } from './_helpers/spawn-hippo.js';

// Forward slashes, since NODE_OPTIONS reads a backslash as an escape.
const REFUSE_SCHEDULER = resolve(__dirname, '_helpers', 'refuse-scheduler.cjs').replaceAll('\\', '/');
const SKIP_LINE = 'HIPPO_SKIP_SCHEDULE=1, so the machine-level daily runner was not scheduled.';

/** `hippo init` with no flags, under a preload that logs and refuses every scheduler call. */
function initWithNoFlags(dir: string, extraEnv: Record<string, string>) {
  const project = join(dir, 'proj');
  const emptyPath = join(dir, 'empty-path');
  mkdirSync(project);
  mkdirSync(emptyPath);
  writeFileSync(join(project, 'CLAUDE.md'), '# project\n');
  const calls = join(dir, 'scheduler-calls.log');
  // An empty PATH as well, so a preload that missed a call still finds no schtasks or crontab to run.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  const env = {
    ...inherited, ...extraEnv, PATH: emptyPath, HIPPO_HOME: join(dir, 'global'), SCHEDULER_CALLS_FILE: calls,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${REFUSE_SCHEDULER}"`,
  };
  const r = hippoRun(['init'], { cwd: project, env });
  return { ...r, calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean) };
}

describe('the suite never reaches the real scheduler', () => {
  it('every test runs with the schedule switched off', () => {
    expect(process.env.HIPPO_SKIP_SCHEDULE).toBe('1');
  });

  it('hippo init with no flags schedules nothing and writes hooks only into the suite home', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hippo-init-noflags-'));
    try {
      const r = initWithNoFlags(dir, {});
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(SKIP_LINE);
      // The preload line proves the refusing wrapper was live in the child; any other line would be a scheduler call.
      expect(r.calls).toEqual(['preload']);
      const fakeHome = process.env.HIPPO_TEST_TMP_USERHOME;
      expect(fakeHome).toBeTruthy();
      expect(existsSync(join(fakeHome!, '.claude', 'settings.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with the switch cleared, init does try the scheduler, which the preload logs and refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hippo-init-sched-on-'));
    try {
      const r = initWithNoFlags(dir, { HIPPO_SKIP_SCHEDULE: '' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain(SKIP_LINE);
      expect(r.stdout).toMatch(/schtasks \/create|To schedule the machine-level daily runner/);
      expect(r.calls[0]).toBe('preload');
      expect(r.calls.length).toBeGreaterThan(1);
      expect(r.calls.slice(1).every((c) => /^(execSync|execFileSync) (schtasks|crontab)\b/.test(c))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
