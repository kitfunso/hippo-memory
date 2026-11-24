import { mkdtempSync } from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { ENV_SCRUBBED_IN_TESTS } from './scripts/lib/test-env-scrub.mjs';
import { EVAL_TESTS, PROCESS_GLOBS, SERVER_GLOBS, SLOW_GLOBS } from './scripts/lib/test-classes.mjs';

const TMP_KEYS = ['TMPDIR', 'TEMP', 'TMP'];
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
const SCRUBBED_ENV_KEYS = ENV_SCRUBBED_IN_TESTS;

// Runs at module scope on purpose: the process.env writes must land before the store guard loads or a worker spawns,
// and vitest evaluates this file once per project.
function isolateTestEnvironment() {
  process.env.HIPPO_TEST_REAL_TMP ??= tmpdir();
  const runTmp = mkdtempSync(join(tmpdir(), 'hippo-test-tmp-'));
  process.env.HIPPO_TEST_TMP_RUN = runTmp;
  for (const k of TMP_KEYS) process.env[k] = runTmp;

  const isolatedHippoHome = mkdtempSync(join(tmpdir(), 'hippo-test-home-'));
  process.env.HIPPO_HOME = isolatedHippoHome;
  process.env.HIPPO_TEST_TMP_HOME = isolatedHippoHome;
  process.env.HIPPO_TEST_REAL_HOME ??= homedir();
  const isolatedUserHome = mkdtempSync(join(tmpdir(), 'hippo-test-userhome-'));
  process.env.HIPPO_TEST_TMP_USERHOME = isolatedUserHome;
  process.env.HOME = isolatedUserHome;
  process.env.USERPROFILE = isolatedUserHome;
  const isolatedAppData = join(isolatedUserHome, 'AppData', 'Roaming');
  process.env.APPDATA = isolatedAppData;
  for (const k of AGENT_HOME_KEYS) delete process.env[k];
  delete process.env.HIPPO_AGENT_MEMORY_TOOLS;
  // This shell may itself be a Claude Code session; the var would leak into every spawned CLI child and falsify null-session_id trace assertions.
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.HIPPO_READ_ONLY;
  for (const k of SCRUBBED_ENV_KEYS) delete process.env[k];
  process.env.HIPPO_SKIP_SCHEDULE = '1';
  process.env.HIPPO_SKIP_EMBEDDER_INSTALL = '1';

  return { runTmp, isolatedHippoHome, isolatedUserHome, isolatedAppData };
}
const { runTmp, isolatedHippoHome, isolatedUserHome, isolatedAppData } = isolateTestEnvironment();

export { EVAL_TESTS };

const TEST_GLOBS = ['tests/**/*.test.ts', 'tests/**/*.test.mjs'];
const UNIT_MS = 5_000;
const SLOW_MS = 180_000;
const SETUP = ['tests/_install-freshness.ts', 'tests/_real-store-guard.ts', 'tests/_store-template.ts'];
const BUILD = ['tests/_build-freshness.ts'];
const SKIPPED = [...configDefaults.exclude, ...EVAL_TESTS];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: TEST_GLOBS,
          exclude: [...SKIPPED, ...PROCESS_GLOBS, ...SERVER_GLOBS, ...SLOW_GLOBS],
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
          name: 'slow',
          include: SLOW_GLOBS,
          exclude: SKIPPED,
          testTimeout: SLOW_MS,
          hookTimeout: SLOW_MS,
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
      HIPPO_SKIP_EMBEDDER_INSTALL: '1',
      HIPPO_READ_ONLY: '',
      ...Object.fromEntries(TMP_KEYS.map((k) => [k, runTmp])),
      ...Object.fromEntries(AGENT_HOME_KEYS.map((k) => [k, ''])),
      ...Object.fromEntries(SCRUBBED_ENV_KEYS.map((k) => [k, ''])),
    },
    maxWorkers: Math.min(6, availableParallelism()),
    coverage: {
      provider: 'v8',
      // Without include, untested src files would not count.
      include: ['src/**/*.ts'],
      excludeAfterRemap: true,
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 90, branches: 82, functions: 95, statements: 89 },
    },
  },
});
