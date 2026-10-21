// The vitest project a test file runs in follows from its name; vitest.config.ts and check-test-env.mjs read this.
// A test that starts a child process, the HTTP server or a worker thread waits on the operating system, so it keeps 30 s.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isLocalSpec, readFacts } from './ts-facts.mjs';

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

/** A test that lifts its own unit budget with `vi.setConfig({ testTimeout })`. */
export const RAISES_OWN_TIMEOUT = /\bvi\.setConfig\(\s*\{\s*testTimeout\b/;

const CHILD_MODULE = /^(?:node:)?child_process$/;
const localImports = new Map();

function resolveLocal(from, spec) {
  const base = resolve(dirname(from), spec.replace(/\.js$/, '.ts'));
  return [base, `${base}.ts`, `${base}/index.ts`].find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

/** The files a source loads at startup (type-only imports are erased) and whether it names child_process itself. */
function importsOf(file) {
  const cached = localImports.get(file);
  if (cached) return cached;
  const live = readFacts(readFileSync(file, 'utf8'), file, ['imports']).imports.filter((i) => !i.typeOnly);
  const facts = {
    child: live.some((i) => CHILD_MODULE.test(i.spec)),
    deps: live
      .filter((i) => isLocalSpec(i.spec))
      .map((i) => resolveLocal(file, i.spec))
      .filter(Boolean),
  };
  localImports.set(file, facts);
  return facts;
}

/**
 * Whether `file` or a module its static imports reach loads child_process. A name match on the test text misses a test
 * that calls an API which spawns git inside src; the import graph sees it.
 * @param {string} file absolute path of a test or source file
 * @returns {boolean}
 */
export function reachesChildProcess(file) {
  const queue = [file];
  const seen = new Set(queue);
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const { child, deps } = importsOf(next);
    if (child) return true;
    for (const dep of deps.filter((d) => !seen.has(d))) {
      seen.add(dep);
      queue.push(dep);
    }
  }
  return false;
}
