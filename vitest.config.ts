import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Isolate the global hippo store for the whole test run. getGlobalRoot()
// (HIPPO_HOME, then XDG_DATA_HOME/hippo, then ~/.hippo) otherwise falls through
// to the developer's real ~/.hippo, which the developer's own Claude Code
// UserPromptSubmit hook (`hippo context`) mutates mid-run — tripping
// tests/_real-store-guard.ts with a false positive. This runs at config module
// scope, in the main process, before globalSetup loads the guard and before any
// test worker is spawned, so the guard, every worker, and any inherited child
// process resolve the global store to this temp dir. HIPPO_TEST_TMP_HOME marks
// the dir so the guard's teardown removes exactly it, and nothing else.
const isolatedHippoHome = mkdtempSync(join(tmpdir(), 'hippo-test-home-'));
process.env.HIPPO_HOME = isolatedHippoHome;
process.env.HIPPO_TEST_TMP_HOME = isolatedHippoHome;
// Fake the home folder too, or `hippo init` imports the developer's ~/.claude memories into test stores.
process.env.HIPPO_TEST_REAL_HOME ??= homedir();
const isolatedUserHome = mkdtempSync(join(tmpdir(), 'hippo-test-userhome-'));
process.env.HIPPO_TEST_TMP_USERHOME = isolatedUserHome;
process.env.HOME = isolatedUserHome;
process.env.USERPROFILE = isolatedUserHome;
delete process.env.XDG_DATA_HOME;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    environment: 'node',
    // Inject HIPPO_HOME into the test workers; the process.env assignment at
    // module scope above covers the main process. Both are required.
    env: { HIPPO_HOME: isolatedHippoHome, HOME: isolatedUserHome, USERPROFILE: isolatedUserHome, XDG_DATA_HOME: '' },
    globalSetup: ['tests/_real-store-guard.ts'],
    // 55 of 384 files spawn git/hippo/nested-vitest children, so one fork per
    // core oversubscribes a big box. Detail: CHANGELOG 1.38.3.
    poolOptions: { forks: { maxForks: 6 } },
    // Real-SQLite tests that take ~2s alone blow the 5s default under that
    // contention, and setup hooks fork more children still, so both get 30s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
