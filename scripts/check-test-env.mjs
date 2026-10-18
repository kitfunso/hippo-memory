#!/usr/bin/env node
// Fails when a test writes process.env by hand: an assignment, a delete or an Object.assign onto it. vi.stubEnv
// with vi.unstubAllEnvs in afterEach restores the value vitest.config.ts set, so a test cannot leak env into the next.
// tests/_helpers/ may own env for a child process. An env object built for a spawn is a read, not a write.
// A vi.stubEnv made once (beforeAll, a describe body, module scope) under an afterEach unstub is gone after the first test.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

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

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? 'tests';
  const hits = findEnvWrites(dir);
  if (hits.length > 0) {
    console.error(`\nTests that write or leak process.env in ${dir}/:`);
    for (const h of hits) console.error(`  ${h.file}:${h.line} ${h.write}`);
    console.error(
      '\nFix: vi.stubEnv(name, value) to set, vi.stubEnv(name, undefined) to unset, and vi.unstubAllEnvs() in afterEach.',
    );
    console.error(
      'A stub made once (beforeAll, describe body, module scope) goes in beforeEach, or pairs with vi.unstubAllEnvs() in afterAll.\n',
    );
    process.exit(1);
  }
  console.log(`No test in ${dir}/ writes process.env by hand. OK.`);
}
