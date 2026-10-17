import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { PROCESS_TESTS } from './tests/_process-tests.js';

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
  'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'COPILOT_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME', 'VSCODE_PORTABLE', 'VSCODE_APPDATA',
  'GEMINI_CLI_HOME', 'QWEN_HOME', 'QWEN_RUNTIME_DIR', 'QWEN_CODE_MEMORY_BASE_DIR', 'QWEN_CODE_MEMORY_LOCAL', 'QWEN_CODE_MEMORY_PROJECT_SCOPE',
  'OPENCLAW_WORKSPACE_DIR', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'OPENCLAW_PROFILE',
];
for (const k of AGENT_HOME_KEYS) delete process.env[k];
delete process.env.HIPPO_AGENT_MEMORY_TOOLS;
const PROVIDER_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'COHERE_API_KEY', 'TYPESAFE_API_KEY', 'HIPPO_LLM_RERANKER_URL', 'HIPPO_LLM_RERANKER_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'HIPPO_CLEF_ENDPOINT', 'HIPPO_CLEF_ENDPOINT_TOKEN'];
for (const k of PROVIDER_ENV_KEYS) delete process.env[k];
// No test may reach the real schtasks or crontab, whatever flags it passes; a test of the schedule clears this and fakes the scheduler.
process.env.HIPPO_SKIP_SCHEDULE = '1';

// Each of these builds real git repositories and worktrees per case, too slow for every shard; token-eval.yml runs them.
export const EVAL_TESTS = [
  'ab-run', 'make-tasks', 'z0-homes', 'z0-turns', 'z0-regrade', 'z0-regrade-resume', 'z0-readcheck', 'z0-chain', 'z0-surfaces', 'z0-timeout', 'z0-leaks', 'z0-grading',
  'z0-codex-run', 'z0-codex-guards', 'z0-codex-faults', 'z0-codex-install',
].map((name) => `tests/token-eval-${name}.test.ts`);

const TEST_GLOBS = ['tests/**/*.test.ts', 'tests/**/*.test.mjs'];
// GitHub's Windows runners stall their D: temp disk for up to two minutes at 10 ms a write (#903), so a unit test
// there gets the process tests' budget.
const UNIT_MS = process.env.GITHUB_ACTIONS === 'true' && process.platform === 'win32' ? 30_000 : 5_000;
const SKIPPED = [...configDefaults.exclude, ...EVAL_TESTS];
export { PROCESS_TESTS };

export default defineConfig({
  test: {
    // A test that starts a process waits on the operating system and keeps 30 s; the rest get UNIT_MS. tests/process-tests-list.test.ts fails when the list goes stale.
    // A file that is slow for a reason this split cannot see raises its own timeout at its top, with one line saying what is slow.
    projects: [
      { extends: true, test: { name: 'unit', include: TEST_GLOBS, exclude: [...SKIPPED, ...PROCESS_TESTS], testTimeout: UNIT_MS, hookTimeout: Math.max(UNIT_MS, 10_000) } },
      { extends: true, test: { name: 'process', include: PROCESS_TESTS, exclude: SKIPPED, testTimeout: 30_000, hookTimeout: 30_000 } },
    ],
    environment: 'node',
    // Workers get the isolated homes and blank provider keys (a real key would bill and leak prompts);
    // the process.env writes at module scope above cover the main process. Both are required.
    env: {
      HIPPO_HOME: isolatedHippoHome, HOME: isolatedUserHome, USERPROFILE: isolatedUserHome, APPDATA: isolatedAppData,
      HIPPO_SKIP_SCHEDULE: '1',
      ...Object.fromEntries(TMP_KEYS.map((k) => [k, runTmp])),
      ...Object.fromEntries(AGENT_HOME_KEYS.map((k) => [k, ''])),
      ...Object.fromEntries(PROVIDER_ENV_KEYS.map((k) => [k, ''])),
    },
    globalSetup: ['tests/_build-freshness.ts', 'tests/_real-store-guard.ts'],
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
