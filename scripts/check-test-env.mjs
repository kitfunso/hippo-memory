#!/usr/bin/env node
// Fails when a test writes process.env by hand: an assignment, a delete or an Object.assign onto it. vi.stubEnv
// with vi.unstubAllEnvs in afterEach restores the value vitest.config.ts set, so a test cannot leak env into the next.
// tests/_helpers/ may own env for a child process. An env object built for a spawn is a read, not a write.
// A vi.stubEnv made once (beforeAll, a describe body, module scope) under an afterEach unstub is gone after the first test.
// Also fails a test whose name puts it in another vitest project than what it starts needs (scripts/lib/test-classes.mjs),
// and a secret, endpoint or path that src/base/util/env.ts reads but scripts/lib/test-env-scrub.mjs (which vitest.config.ts blanks) lacks.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ENV_SCRUBBED_IN_TESTS } from './lib/test-env-scrub.mjs';
import {
  EVAL_TESTS,
  RAISES_OWN_TIMEOUT,
  STARTS_A_CHILD,
  STARTS_A_SERVER,
  projectOfName,
  reachesChildProcess,
} from './lib/test-classes.mjs';

const isProcessEnv = (e) => e.getText() === 'process.env';
const isEnvMember = (e) =>
  (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && isProcessEnv(e.expression);

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => {
    visit(child, fn);
  });
}

/**
 * Returns one entry per write onto process.env in a test source.
 * @param {string} text
 * @returns {{ line: number, write: string }[]}
 */
export function envWrites(text) {
  if (!text.includes('process.env')) return [];
  const sf = ts.createSourceFile('test.ts', text, ts.ScriptTarget.Latest, true);
  const hits = [];
  visit(sf, (n) => {
    const assigns =
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (isEnvMember(n.left) || isProcessEnv(n.left));
    const deletes = ts.isDeleteExpression(n) && isEnvMember(n.expression);
    const assignsInto =
      ts.isCallExpression(n) &&
      n.expression.getText() === 'Object.assign' &&
      n.arguments.length > 0 &&
      isProcessEnv(n.arguments[0]);
    if (assigns || deletes || assignsInto) {
      hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, write: n.getText().slice(0, 60) });
    }
  });
  return hits;
}

const callName = (call) => {
  let e = call.expression;
  while (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : '';
};
const callsUnstub = (n) => {
  let found = false;
  visit(n, (c) => {
    if (ts.isCallExpression(c) && c.expression.getText() === 'vi.unstubAllEnvs') found = true;
  });
  return found;
};
const bodyOf = (call) => call.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));

/**
 * Returns one entry per vi.stubEnv made once, in beforeAll, a describe body or module scope, that an afterEach
 * vi.unstubAllEnvs in the same or an enclosing scope wipes after the first test.
 * @param {string} text
 * @returns {{ line: number, write: string }[]}
 */
export function onceStubs(text) {
  if (!text.includes('stubEnv') || !text.includes('unstubAllEnvs')) return [];
  const sf = ts.createSourceFile('test.ts', text, ts.ScriptTarget.Latest, true);
  const hits = [];
  visit(sf, (n) => {
    if (!ts.isCallExpression(n) || n.expression.getText() !== 'vi.stubEnv') return;
    const scopes = [];
    let once = null;
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const name = callName(p);
        if (['it', 'test', 'beforeEach', 'afterEach', 'afterAll'].includes(name)) return;
        if (name === 'beforeAll' && once === null) once = true;
        if (name === 'describe') {
          scopes.push(bodyOf(p));
          once ??= true;
        }
      } else if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && once === null) return;
      else if (ts.isVariableDeclaration(p) && p.initializer && ts.isFunctionLike(p.initializer) && once === null) {
        return;
      }
    }
    scopes.push(sf);
    const eachUnstub = scopes.some((scope) => {
      const stmts = ts.isSourceFile(scope) ? scope.statements : (scope.body.statements ?? []);
      return stmts.some(
        (st) =>
          ts.isExpressionStatement(st) &&
          ts.isCallExpression(st.expression) &&
          callName(st.expression) === 'afterEach' &&
          callsUnstub(st.expression),
      );
    });
    if (eachUnstub) {
      hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, write: n.getText().slice(0, 60) });
    }
  });
  return hits;
}

/**
 * Returns one entry per vi.unstubAllEnvs that runs before an await, a stop or a close in the same block: whatever
 * that teardown still does then runs on the shared test home instead of the test's own.
 * @param {string} text
 * @returns {{ line: number, write: string }[]}
 */
export function earlyUnstubs(text) {
  if (!text.includes('unstubAllEnvs')) return [];
  const sf = ts.createSourceFile('test.ts', text, ts.ScriptTarget.Latest, true);
  const hits = [];
  visit(sf, (n) => {
    const hook =
      ts.isFunctionLike(n.parent) &&
      ts.isCallExpression(n.parent.parent) &&
      ['afterEach', 'afterAll'].includes(callName(n.parent.parent));
    if (!ts.isBlock(n) || !(hook || (ts.isTryStatement(n.parent) && n.parent.finallyBlock === n))) return;
    const i = n.statements.findIndex((st) => st.getText().startsWith('vi.unstubAllEnvs()'));
    if (i < 0) return;
    const later = n.statements
      .slice(i + 1)
      .map((st) => st.getText())
      .join(' ');
    if (/\bawait\b|\.(stop|close|closeAllConnections|kill)\(/.test(later)) {
      hits.push({
        line: sf.getLineAndCharacterOfPosition(n.statements[i].getStart(sf)).line + 1,
        write: 'vi.unstubAllEnvs() (before a teardown that still runs)',
      });
    }
  });
  return hits;
}

function testFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '_helpers') testFiles(p, out);
    } else if (/\.(ts|mjs|cjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {{ file: string, line: number, write: string }[]}
 */
export function findEnvWrites(dir) {
  return testFiles(dir).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    const name = file.replaceAll('\\', '/');
    return [
      ...envWrites(text).map((hit) => ({ file: name, ...hit })),
      ...earlyUnstubs(text).map((hit) => ({ file: name, ...hit })),
      ...onceStubs(text).map((hit) => ({
        file: name,
        ...hit,
        write: `${hit.write} (set once, wiped by afterEach unstubAllEnvs)`,
      })),
    ];
  });
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a source starts what `starts` matches, itself or through a tests/_helpers module that does. */
function startsVia(helpers, starts) {
  const starters = new Set(helpers.filter((h) => starts.test(h.source)).map((h) => h.name));
  let importsStarter = () => false;
  // A helper that imports a starter is one too, so this repeats until a pass adds none.
  for (let known = -1; known !== starters.size;) {
    known = starters.size;
    if (known === 0) break;
    const names = new RegExp(`(?:_helpers|\\.)/(?:${[...starters].map(escapeRegExp).join('|')})\\.`);
    importsStarter = (source) => names.test(source);
    for (const h of helpers) if (importsStarter(h.source)) starters.add(h.name);
  }
  return (source) => starts.test(source) || importsStarter(source);
}

function filesUnder(dir, keep, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') filesUnder(p, keep, out);
    } else if (keep(e.name)) out.push(p);
  }
  return out;
}

/**
 * Returns one entry per test file whose name puts it in another vitest project than the one its code needs: a test
 * that starts a child process is `*.process.test.*`, one that starts only the server or a worker thread
 * `*.server.test.*`, and no other test has either name. The eval config runs EVAL_TESTS, so they keep their names.
 * @param {string} dir the tests folder
 * @returns {{ file: string, has: string, want: string }[]}
 */
export function misnamedTests(dir) {
  const helperDir = join(dir, '_helpers');
  const helpers = existsSync(helperDir)
    ? readdirSync(helperDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => ({ name: e.name.replace(/\.\w+$/, ''), source: readFileSync(join(helperDir, e.name), 'utf8') }))
    : [];
  const startsChild = startsVia(helpers, STARTS_A_CHILD);
  const startsServer = startsVia(helpers, STARTS_A_SERVER);
  const skipped = new Set(EVAL_TESTS);
  // The token-eval harness belongs to another owner and keeps its names.
  const hits = [];
  for (const path of filesUnder(dir, (n) => /\.test\.(ts|mjs)$/.test(n))) {
    const file = relative(dirname(dir), path).replaceAll('\\', '/');
    if (skipped.has(file) || file.startsWith('tests/token-eval-')) continue;
    const source = readFileSync(path, 'utf8');
    const has = projectOfName(file);
    // A test that spawns inside src never names child_process, so the import graph decides when it lifts its own budget.
    const waitsOnChild = startsChild(source) || (RAISES_OWN_TIMEOUT.test(source) && reachesChildProcess(path));
    const want =
      waitsOnChild || (has === 'process' && reachesChildProcess(path))
        ? 'process'
        : startsServer(source)
          ? 'server'
          : 'unit';
    if (want !== has) hits.push({ file, has, want });
  }
  return hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** The variable names a reader in env.ts is built from. */
const READER = /\b(?:raw|text|trimmedText|posInt|nonNegInt|strictPosInt)\('([A-Z][A-Z0-9_]*)'/g;
// HIPPO_HOME, HOME and USERPROFILE get isolated directories in vitest.config.ts rather than a blank.
const SET_BY_VITEST = new Set(['HIPPO_HOME', 'HOME', 'USERPROFILE']);
const SENSITIVE = /KEY|TOKEN|SECRET|PASSWORD|ENDPOINT|ACCOUNT_ID|_URL$|_CERT$|_CACHE$|_HOME$/;

/**
 * Returns the variable names env.ts reads that look like a secret, endpoint or path and are not in ENV_SCRUBBED_IN_TESTS.
 * @param {string} envSource the text of src/base/util/env.ts
 * @param {readonly string[]} [scrubbedNames] defaults to the list vitest.config.ts blanks
 * @returns {string[]}
 */
export function unscrubbedEnvReads(envSource, scrubbedNames = ENV_SCRUBBED_IN_TESTS) {
  const scrubbed = new Set(scrubbedNames);
  const read = new Set([...envSource.matchAll(READER)].map((m) => m[1]));
  return [...read].filter((n) => SENSITIVE.test(n) && !SET_BY_VITEST.has(n) && !scrubbed.has(n)).sort();
}

const RENAME = {
  process: 'starts a child process: name it *.process.test.ts',
  server: 'starts the server or a worker thread and no child: name it *.server.test.ts',
  unit: 'starts no child, server or worker thread: drop .process or .server from its name',
};

function report(dir, hits, misnamed, unscrubbed) {
  if (hits.length > 0) {
    console.error(`\nTests that write or leak process.env in ${dir}/:`);
    for (const h of hits) console.error(`  ${h.file}:${h.line} ${h.write}`);
    console.error(
      '\nFix: vi.stubEnv(name, value) to set, vi.stubEnv(name, undefined) to unset, and vi.unstubAllEnvs() in afterEach.',
    );
    console.error(
      'A stub made once (beforeAll, describe body, module scope) goes in beforeEach, or pairs with vi.unstubAllEnvs() in afterAll.\n',
    );
  }
  if (misnamed.length > 0) {
    console.error(`\nTests whose name puts them in the wrong vitest project in ${dir}/:`);
    for (const m of misnamed) console.error(`  ${m.file} ${RENAME[m.want]}`);
    console.error(
      '\nThe unit project gives a test 5 s; one that waits on another process or thread needs the 30 s project.' +
        "\nRename the test's __snapshots__/<name>.snap with it, or CI finds no snapshot.\n",
    );
  }
  if (unscrubbed.length > 0) {
    console.error(`\nsrc/base/util/env.ts reads these but ENV_SCRUBBED_IN_TESTS lacks them: ${unscrubbed.join(', ')}`);
    console.error('Add each name to ENV_SCRUBBED_IN_TESTS there, so vitest.config.ts blanks it for every test.\n');
  }
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? 'tests';
  const hits = findEnvWrites(dir);
  const misnamed = misnamedTests(dir);
  const envFile = join(dirname(dir), 'src/base/util/env.ts');
  const unscrubbed = existsSync(envFile) ? unscrubbedEnvReads(readFileSync(envFile, 'utf8')) : [];
  report(dir, hits, misnamed, unscrubbed);
  if (hits.length > 0 || misnamed.length > 0 || unscrubbed.length > 0) process.exit(1);
  console.log(`No test in ${dir}/ writes process.env by hand, and each test's name matches what it starts. OK.`);
}
