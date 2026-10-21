import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { ENV_SCRUBBED_IN_TESTS } from './scripts/lib/test-env-scrub.mjs';
import { EVAL_TESTS, PROCESS_GLOBS, SERVER_GLOBS } from './scripts/lib/test-classes.mjs';

// Scratch dirs a test forgets to delete land in this run folder, which the guard's teardown removes.
process.env.HIPPO_TEST_REAL_TMP ??= tmpdir();
const TMP_KEYS = ['TMPDIR', 'TEMP', 'TMP'];
const runTmp = mkdtempSync(join(tmpdir(), 'hippo-test-tmp-'));
process.env.HIPPO_TEST_TMP_RUN = runTmp;
for (const k of TMP_KEYS) process.env[k] = runTmp;

// The developer's own hooks write the real ~/.hippo mid-run, so set at module scope, before the guard loads or a worker spawns, every process resolves this dir.
// HIPPO_TEST_TMP_HOME marks it so the guard's teardown removes exactly it.
const isolatedHippoHome = mkdtempSync(join(tmpdir(), 'hippo-test-home-'));
process.env.HIPPO_HOME = isolatedHippoHome;
process.env.HIPPO_TEST_TMP_HOME = isolatedHippoHome;
// Fake the home folder too, or `hippo init` imports the developer's ~/.claude memories into test stores.
process.env.HIPPO_TEST_REAL_HOME ??= homedir();
const isolatedUserHome = mkdtempSync(join(tmpdir(), 'hippo-test-userhome-'));
process.env.HIPPO_TEST_TMP_USERHOME = isolatedUserHome;
process.env.HOME = isolatedUserHome;
process.env.USERPROFILE = isolatedUserHome;
// Agent memory folders the import finds through the environment rather than the home folder (Copilot's VS Code data, and each tool's override).
const isolatedAppData = join(isolatedUserHome, 'AppData', 'Roaming');
process.env.APPDATA = isolatedAppData;
const AGENT_HOME_KEYS = [
  'XDG_CONFIG_HOME',
  'CODEX_HOME',
  'COPILOT_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PROJECT_DIR_NAME',
  'VSCODE_PORTABLE',
  'VSCODE_APPDATA',
  'GEMINI_CLI_HOME',
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'QWEN_CODE_MEMORY_BASE_DIR',
  'QWEN_CODE_MEMORY_LOCAL',
  'QWEN_CODE_MEMORY_PROJECT_SCOPE',
  'OPENCLAW_WORKSPACE_DIR',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_HOME',
  'OPENCLAW_PROFILE',
];
for (const k of AGENT_HOME_KEYS) delete process.env[k];
delete process.env.HIPPO_AGENT_MEMORY_TOOLS;
// This shell may itself be a Claude Code session; the var would leak into every spawned CLI child and falsify null-session_id trace assertions.
delete process.env.CLAUDE_CODE_SESSION_ID;
// check-test-env.mjs fails a secret, endpoint or path that src/base/util/env.ts reads and this list lacks.
const SCRUBBED_ENV_KEYS = ENV_SCRUBBED_IN_TESTS;
for (const k of SCRUBBED_ENV_KEYS) delete process.env[k];
// No test may reach the real schtasks or crontab, whatever flags it passes; a test of the schedule clears this and fakes the scheduler.
process.env.HIPPO_SKIP_SCHEDULE = '1';

// token-eval.yml runs these through vitest.eval.config.ts, which reads them from here.
export { EVAL_TESTS };

const TEST_GLOBS = ['tests/**/*.test.ts', 'tests/**/*.test.mjs'];
const UNIT_MS = 5_000;
const SETUP = ['tests/_install-freshness.ts', 'tests/_real-store-guard.ts', 'tests/_store-template.ts'];
// Only tests that run dist (child processes, the server, workers) need a build, so the unit project starts without one.
const BUILD = ['tests/_build-freshness.ts'];
const SKIPPED = [...configDefaults.exclude, ...EVAL_TESTS];

export default defineConfig({
  test: {
    // A test that starts a child process, the HTTP server or a worker thread waits on the operating system and keeps 30 s; the rest get UNIT_MS.
    // Its name says which (*.process.test.ts, *.server.test.ts); scripts/check-test-env.mjs fails a name that does not match.
    // A file that is slow for a reason this split cannot see raises its own timeout at its top, with one line saying what is slow.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: TEST_GLOBS,
          exclude: [...SKIPPED, ...PROCESS_GLOBS, ...SERVER_GLOBS],
          testTimeout: UNIT_MS,
          hookTimeout: Math.max(UNIT_MS, 10_000),
        },
      },
      {
        extends: true,
        test: {
          name: 'process',
          include: PROCESS_GLOBS,
          exclude: SKIPPED,
          globalSetup: BUILD,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          include: SERVER_GLOBS,
          exclude: SKIPPED,
          globalSetup: BUILD,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    // One run of the guard and the template, however many projects a run selects; only the build check is per project.
    globalSetup: SETUP,
    environment: 'node',
    // Workers get the isolated homes and blank provider keys (a real key would bill and leak prompts);
    // the process.env writes at module scope above cover the main process. Both are required.
    env: {
      HIPPO_HOME: isolatedHippoHome,
      HOME: isolatedUserHome,
      USERPROFILE: isolatedUserHome,
      APPDATA: isolatedAppData,
      HIPPO_SKIP_SCHEDULE: '1',
      ...Object.fromEntries(TMP_KEYS.map((k) => [k, runTmp])),
      ...Object.fromEntries(AGENT_HOME_KEYS.map((k) => [k, ''])),
      ...Object.fromEntries(SCRUBBED_ENV_KEYS.map((k) => [k, ''])),
    },
    // About a fifth of the files spawn git/hippo/nested-vitest children, so one fork per core oversubscribes a big box (CHANGELOG 1.38.3).
    maxWorkers: 6,
    coverage: {
      // CLI output checks run in process through runCliAs, so plain v8 sees that code without following spawned children.
      provider: 'v8',
      // Without include, untested src files would not count.
      include: ['src/**/*.ts'],
      excludeAfterRemap: true,
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 90, branches: 82, functions: 95, statements: 89 },
    },
  },
});
