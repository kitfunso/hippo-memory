#!/usr/bin/env node
// Fails when a test file builds a store by hand, in any of three shapes: initStore, openStore or openHippoDb on a path built
// from a mkdtempSync dir; a mkdtempSync dir handed to a hippo CLI call as its cwd or as HIPPO_HOME, so the CLI builds the store
// there; or one of the three called on a function's own parameter, so the store's dir was made somewhere else.
// makeRoot and makeStore in tests/_helpers/make-root.ts make the dir, init the store and remove it, so a store is built one
// way in every test. A temp dir for a fake home, a vault or a plain file stays a mkdtempSync.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const STORE_OPENERS = new Set(['initStore', 'initTestStore', 'openStore', 'openHippoDb']);
const PATH_FUNCTIONS = new Set(['join', 'resolve', 'dirname', 'normalize', 'realpathSync', 'native']);
const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);

const calleeName = (call) =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : '';

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => {
    visit(child, fn);
  });
}

/** True when the expression only joins, resolves or concatenates path parts: the shapes a temp dir flows through on its way to a store. */
function isPathExpression(e) {
  if (ts.isIdentifier(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isTemplateExpression(e)) return e.templateSpans.every((span) => isPathExpression(span.expression));
  if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) {
    return isPathExpression(e.expression);
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isPathExpression(e.left) && isPathExpression(e.right);
  }
  return ts.isCallExpression(e) && PATH_FUNCTIONS.has(calleeName(e)) && e.arguments.every(isPathExpression);
}

/** Names an expression reads, leaving out property names (`x.root` reads `x`, not `root`). */
function readNames(node) {
  const names = new Set();
  visit(node, (n) => {
    const p = n.parent;
    const isPropertyName =
      p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n));
    if (ts.isIdentifier(n) && !isPropertyName) names.add(n.text);
  });
  return names;
}

const propertyNamed = (obj, name) =>
  obj.properties.find(
    (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === name,
  );
const valueOf = (p) => (ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer);

/** True when the call is inside a function that takes the name as a parameter. */
function isParameter(call, name) {
  for (let p = call.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) && p.parameters.some((param) => ts.isIdentifier(param.name) && param.name.text === name)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns one entry per hand-built store in a test source: see the three shapes at the top of this file.
 * @param {string} text
 * @returns {{ line: number, call: string }[]}
 */
export function handBuiltStores(text) {
  const sf = ts.createSourceFile('test.ts', text, ts.ScriptTarget.Latest, true);
  const fromTemp = (e) => {
    let found = false;
    visit(e, (x) => {
      if (ts.isCallExpression(x) && calleeName(x) === 'mkdtempSync') found = true;
    });
    return found;
  };
  const assigns = [];
  visit(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      assigns.push([n.name.text, n.initializer]);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      assigns.push([n.left.text, n.right]);
    }
  });
  const tainted = new Set(assigns.filter(([, init]) => fromTemp(init)).map(([name]) => name));
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, init] of assigns) {
      if (!tainted.has(name) && isPathExpression(init) && [...readNames(init)].some((r) => tainted.has(r))) {
        tainted.add(name);
        grew = true;
      }
    }
  }
  const isTemp = (e) => fromTemp(e) || [...readNames(e)].some((r) => tainted.has(r));
  // The dir itself, not a path inside it: a CLI given the dir builds its store there.
  const isTempDir = (e) =>
    (ts.isIdentifier(e) && tainted.has(e.text)) ||
    (ts.isCallExpression(e) &&
      e.arguments.length === 1 &&
      PATH_FUNCTIONS.has(calleeName(e)) &&
      isTempDir(e.arguments[0])) ||
    (ts.isCallExpression(e) && calleeName(e) === 'mkdtempSync');
  const hits = [];
  const hit = (n) =>
    hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, call: n.getText().slice(0, 60) });
  visit(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n);
    if (STORE_OPENERS.has(name)) {
      if (
        n.arguments.some(isTemp) ||
        (name !== 'openHippoDb' && n.arguments.some((a) => ts.isIdentifier(a) && isParameter(n, a.text)))
      ) {
        hit(n);
      }
    } else if (n.expression.getText() === 'vi.stubEnv') {
      if (n.arguments[0]?.getText() === "'HIPPO_HOME'" && n.arguments[1] && isTempDir(n.arguments[1])) hit(n);
    } else if (SPAWNERS.has(name) && /hippo/i.test(n.getText())) {
      const opts = n.arguments.filter(ts.isObjectLiteralExpression);
      const env = opts
        .map((o) => propertyNamed(o, 'env'))
        .filter(Boolean)
        .map(valueOf)
        .filter(ts.isObjectLiteralExpression);
      const cwdOrHome = [
        ...opts.map((o) => propertyNamed(o, 'cwd')),
        ...[...opts, ...env].map((o) => propertyNamed(o, 'HIPPO_HOME')),
      ].filter(Boolean);
      if (cwdOrHome.some((p) => isTempDir(valueOf(p)))) hit(n);
    }
  });
  return hits;
}

function testFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') testFiles(p, out);
    } else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {{ file: string, line: number, call: string }[]}
 */
export function findHandBuiltStores(dir) {
  return testFiles(dir).flatMap((file) =>
    handBuiltStores(readFileSync(file, 'utf8')).map((hit) => ({ file: file.replace(/\\/g, '/'), ...hit })),
  );
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? 'tests';
  const hits = findHandBuiltStores(dir);
  if (hits.length > 0) {
    console.error(`\nTests that build a store by hand in ${dir}/:`);
    for (const h of hits) console.error(`  ${h.file}:${h.line} ${h.call}`);
    console.error(
      '\nFix: make the dir with makeRoot or makeStore from tests/_helpers/make-root.ts; it inits the store and removes the dir.',
    );
    console.error('A test that needs a folder that is not a store yet takes makeRoot(label, { init: false }).\n');
    process.exit(1);
  }
  console.log(`No test in ${dir}/ builds a store from its own mkdtempSync dir. OK.`);
}
