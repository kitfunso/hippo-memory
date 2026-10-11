import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

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
// Most server tests speak as the keyless local caller; the tests of the key-required default delete this.
process.env.HIPPO_ALLOW_KEYLESS_LOCAL = '1';
// No test may reach the real schtasks or crontab, whatever flags it passes; a test of the schedule clears this and fakes the scheduler.
process.env.HIPPO_SKIP_SCHEDULE = '1';

// Each of these builds real git repositories and worktrees per case, too slow for every shard; token-eval.yml runs them.
export const EVAL_TESTS = ['ab-run', 'make-tasks', 'z0-homes', 'z0-turns', 'z0-codex-run', 'z0-codex-guards', 'z0-codex-faults', 'z0-codex-install'].map((name) => `tests/token-eval-${name}.test.ts`);

const TEST_GLOBS = ['tests/**/*.test.ts', 'tests/**/*.test.mjs'];
const SKIPPED = [...configDefaults.exclude, ...EVAL_TESTS];
const STARTS_A_PROCESS = /\bchild_process\b|\bworker_threads\b|\bserve\(/;

/** Test files that start a process, a worker thread or the HTTP server, in their own code or through a tests/_helpers module. */
function processTests(): string[] {
  const tests = join(import.meta.dirname, 'tests');
  const read = (file: string): string => readFileSync(join(tests, file), 'utf8');
  const helpers = readdirSync(join(tests, '_helpers')).map((file) => ({ name: file.replace(/\.\w+$/, ''), source: read(join('_helpers', file)) }));
  const starters = new Set(helpers.filter((helper) => STARTS_A_PROCESS.test(helper.source)).map((helper) => helper.name));
  const importsStarter = (source: string): boolean => new RegExp(`(?:_helpers|\\.)/(?:${[...starters].join('|')})\\.`).test(source);
  // A helper that imports a starter is one too, so this repeats until a pass adds none.
  for (let known = -1; known !== starters.size;) {
    known = starters.size;
    for (const helper of helpers) if (importsStarter(helper.source)) starters.add(helper.name);
  }
  return readdirSync(tests, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.test\.(ts|mjs)$/.test(file))
    .filter((file) => { const source = read(file); return STARTS_A_PROCESS.test(source) || importsStarter(source); })
    .map((file) => `tests/${file.replaceAll('\\', '/')}`);
}
const PROCESS_TESTS = processTests();

export default defineConfig({
  test: {
    // A test that starts a process waits on the operating system and keeps 30 s; the rest get 5 s, read from each file's source, as a list of names goes stale.
    // A file that is slow for a reason this split cannot see raises its own timeout at its top, with one line saying what is slow.
    projects: [
      { extends: true, test: { name: 'unit', include: TEST_GLOBS, exclude: [...SKIPPED, ...PROCESS_TESTS], testTimeout: 5_000, hookTimeout: 10_000 } },
      { extends: true, test: { name: 'process', include: PROCESS_TESTS, exclude: SKIPPED, testTimeout: 30_000, hookTimeout: 30_000 } },
    ],
    environment: 'node',
    // Workers get the isolated homes and blank provider keys (a real key would bill and leak prompts);
    // the process.env writes at module scope above cover the main process. Both are required.
    env: {
      HIPPO_HOME: isolatedHippoHome, HOME: isolatedUserHome, USERPROFILE: isolatedUserHome, APPDATA: isolatedAppData,
      HIPPO_ALLOW_KEYLESS_LOCAL: '1', HIPPO_SKIP_SCHEDULE: '1',
      ...Object.fromEntries(TMP_KEYS.map((k) => [k, runTmp])),
      ...Object.fromEntries(AGENT_HOME_KEYS.map((k) => [k, ''])),
      ...Object.fromEntries(PROVIDER_ENV_KEYS.map((k) => [k, ''])),
    },
    globalSetup: ['tests/_build-freshness.ts', 'tests/_real-store-guard.ts'],
    server: { deps: { external: [/tests[\\/]_coverage-provider\.mjs$/] } },
    // About a fifth of the files spawn git/hippo/nested-vitest children, so one fork per core oversubscribes a big box (CHANGELOG 1.38.3).
    maxWorkers: 6,
    coverage: {
      provider: 'custom',
      customProviderModule: './tests/_coverage-provider.mjs',
      // Without include, untested src files would not count; dist/ lets spawned-CLI results through to remap.
      include: ['src/**/*.ts', 'dist/**/*.js'],
      autoAttachSubprocess: true,
      excludeAfterRemap: true,
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 90, branches: 82, functions: 95, statements: 89 },
    },
  },
});
