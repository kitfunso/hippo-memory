// The vitest project a test file runs in follows from its name; vitest.config.ts and check-test-env.mjs read this.
// A test that starts a child process, the HTTP server or a worker thread waits on the operating system, so it keeps 30 s.

/** Each builds real git repositories and worktrees per case, too slow for every shard: vitest.eval.config.ts runs them. */
export const EVAL_TESTS = [
  'ab-run',
  'make-tasks',
  'z0-homes',
  'z0-turns',
  'z0-regrade',
  'z0-regrade-resume',
  'z0-readcheck',
  'z0-chain',
  'z0-surfaces',
  'z0-timeout',
  'z0-leaks',
  'z0-grading',
  'z0-codex-run',
  'z0-codex-guards',
  'z0-codex-faults',
  'z0-codex-install',
].map((name) => `tests/token-eval-${name}.test.ts`);

export const PROCESS_GLOBS = ['tests/**/*.process.test.ts', 'tests/**/*.process.test.mjs'];
export const SERVER_GLOBS = ['tests/**/*.server.test.ts', 'tests/**/*.server.test.mjs'];

/** A test that names the child process module starts a child. */
export const STARTS_A_CHILD = /\bchild_process\b/;
/** The worker store and the dashboard start their threads inside src, so a test that builds one never names the thread module. */
export const STARTS_A_SERVER = /\bworker_threads\b|\bserve\(|\bserveDashboard\(|\bworkerSqliteStore\(/;

/**
 * The project a test file's name puts it in.
 * @param {string} file
 * @returns {'process' | 'server' | 'unit'}
 */
export function projectOfName(file) {
  const m = /\.(process|server)\.test\.(ts|mjs)$/.exec(file);
  return m ? /** @type {'process' | 'server'} */ (m[1]) : 'unit';
}
