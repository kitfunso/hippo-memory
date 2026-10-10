// The globalSetup leak verdict itself, and that workers write to the global store it watches.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, teardown } from './_real-store-guard.js';

let home: string;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'hippo-guard-leak-')));
  vi.stubEnv('HIPPO_HOME', home);
  // Blank, so a clean teardown here cannot remove this run's own temp dirs.
  for (const key of ['HIPPO_TEST_TMP_HOME', 'HIPPO_TEST_TMP_USERHOME', 'HIPPO_TEST_TMP_RUN']) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('real-store guard', () => {
  it('passes a run that left the watched global store alone', () => {
    setup();
    expect(() => teardown()).not.toThrow();
  });

  it('fails a run that wrote to the watched global store', () => {
    setup();
    writeFileSync(join(home, 'hippo.db'), 'leaked');
    expect(() => teardown()).toThrow(`Test-isolation leak: the test run mutated hippo store(s): ${home}`);
  });
});

describe('vitest.config.ts isolation', () => {
  it('gives workers the global store the guard watches', () => {
    vi.unstubAllEnvs();
    expect(process.env.HIPPO_HOME).toBeTruthy();
    expect(process.env.HIPPO_HOME).toBe(process.env.HIPPO_TEST_TMP_HOME);
  });
});
