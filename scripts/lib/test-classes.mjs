// The vitest project a test file runs in follows from its name; vitest.config.ts and check-test-env.mjs read this.
// A test that starts a child process, the HTTP server or a worker thread waits on the operating system, so it keeps 30 s.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
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
  'z0-codex-session.process',
  'z0-snapfail',
  'replay',
].map((name) => `tests/eval/token-eval-${name}.test.ts`);

export const PROCESS_GLOBS = ['tests/**/*.process.test.ts', 'tests/**/*.process.test.mjs'];
export const SERVER_GLOBS = ['tests/**/*.server.test.ts', 'tests/**/*.server.test.mjs'];
/** Tests that start nothing but need seconds of CPU or disk: a seed past a page, a TypeScript program over src. */
export const SLOW_GLOBS = ['tests/**/*.slow.test.ts', 'tests/**/*.slow.test.mjs'];
/** No test, hook or vitest wait in the default run sets more than this of its own: a test waits on an event, not a timer. */
export const OWN_TIMEOUT_CEILING_MS = 10_000;

/** A test that names the child process module starts a child. */
export const STARTS_A_CHILD = /\bchild_process\b/;
/** The worker store and the dashboard start their threads inside src, so a test that builds one never names the thread module. */
export const STARTS_A_SERVER = /\bworker_threads\b|\bserve\(|\bserveDashboard\(|\bworkerSqliteStore\(/;

/**
 * The project a test file's name puts it in.
 * @param {string} file
 * @returns {'process' | 'server' | 'slow' | 'unit'}
 */
export function projectOfName(file) {
  const m = /\.(process|server|slow)\.test\.(ts|mjs)$/.exec(file);
  return m ? /** @type {'process' | 'server' | 'slow'} */ (m[1]) : 'unit';
}

const TESTS = new Set(['it', 'test', 'describe', 'suite']);
const HOOKS = new Set([
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
  'aroundEach',
  'aroundAll',
  'onTestFinished',
  'onTestFailed',
]);
const CONTEXT_HOOKS = new Set(['onTestFinished', 'onTestFailed']);
const MODIFIERS = new Set(['only', 'skip', 'concurrent', 'sequential', 'fails', 'todo', 'shuffle']);
const TABLE_MODIFIERS = new Set(['each', 'for', 'skipIf', 'runIf', 'extend']);

/** 'test' or 'hook' for a callee that is a test function, a hook or an alias of one, through any modifier. */
function apiOf(e, aliases) {
  if (ts.isIdentifier(e)) {
    if (aliases.has(e.text)) return aliases.get(e.text);
    return TESTS.has(e.text) ? 'test' : HOOKS.has(e.text) ? 'hook' : null;
  }
  if (ts.isPropertyAccessExpression(e)) {
    if (CONTEXT_HOOKS.has(e.name.text)) return 'hook';
    return MODIFIERS.has(e.name.text) ? apiOf(e.expression, aliases) : null;
  }
  if (ts.isConditionalExpression(e)) return apiOf(e.whenTrue, aliases) ?? apiOf(e.whenFalse, aliases);
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    return TABLE_MODIFIERS.has(e.expression.name.text) ? apiOf(e.expression.expression, aliases) : null;
  }
  return null;
}

/** The names a source binds to a test function or hook: `import { it as x }`, `const x = it`, `const x = test.extend()`. */
function aliasesOf(sourceFile) {
  const aliases = new Map();
  const visit = (n) => {
    if (ts.isImportSpecifier(n) && n.propertyName) {
      const api = TESTS.has(n.propertyName.text) ? 'test' : HOOKS.has(n.propertyName.text) ? 'hook' : null;
      if (api) aliases.set(n.name.text, api);
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const api = apiOf(n.initializer, aliases);
      if (api) aliases.set(n.name.text, api);
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return aliases;
}

/** Milliseconds a timeout argument names, null when it is not a literal, undefined when it sets none. */
function msOf(arg, key = 'timeout') {
  if (!arg) return undefined;
  if (ts.isNumericLiteral(arg)) return Number(arg.text);
  if (!ts.isObjectLiteralExpression(arg)) return null;
  const prop = arg.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === key);
  if (prop) {
    return ts.isPropertyAssignment(prop) && ts.isNumericLiteral(prop.initializer)
      ? Number(prop.initializer.text)
      : null;
  }
  return arg.properties.some((p) => ts.isSpreadAssignment(p)) ? null : undefined;
}

const isMember = (e, object, name) =>
  ts.isPropertyAccessExpression(e) &&
  ts.isIdentifier(e.expression) &&
  e.expression.text === object &&
  e.name.text === name;

/** The timeouts one call sets: a test's third argument or options object, a hook's second, a vitest wait's options. */
function timeoutsOf(call, aliases) {
  const [first, second, third] = call.arguments;
  if (isMember(call.expression, 'vi', 'setConfig')) return [msOf(first, 'testTimeout'), msOf(first, 'hookTimeout')];
  if (isMember(call.expression, 'vi', 'waitFor') || isMember(call.expression, 'expect', 'poll')) return [msOf(second)];
  const api = apiOf(call.expression, aliases);
  if (api === 'hook') return [msOf(second)];
  if (api !== 'test') return [];
  // Options sit second only as a literal (`describe(name, { timeout }, fn)`); anything third that is not the body counts.
  const options = second && (ts.isObjectLiteralExpression(second) || ts.isNumericLiteral(second)) ? second : undefined;
  return [msOf(options), third && !isFunction(third) ? msOf(third) : undefined];
}

const isFunction = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/**
 * Every timeout a test source sets for itself: per test, suite or hook (with any modifier or alias), vi.setConfig,
 * vi.waitFor and expect.poll. A name, an expression or a spread gives `ms: null`, since its value is unknown here.
 * @param {string} source
 * @param {string} [fileName]
 * @returns {{ line: number, ms: number | null }[]}
 */
export function ownTimeouts(source, fileName = 'file.ts') {
  const { sourceFile } = readFacts(source, fileName, []);
  const aliases = aliasesOf(sourceFile);
  const found = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const line = sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1;
      for (const ms of timeoutsOf(n, aliases)) if (ms !== undefined) found.push({ line, ms });
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return found;
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
