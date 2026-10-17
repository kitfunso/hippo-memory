#!/usr/bin/env node
// Fails when a test writes process.env by hand: an assignment, a delete or an Object.assign onto it. vi.stubEnv
// with vi.unstubAllEnvs in afterEach restores the value vitest.config.ts set, so a test cannot leak env into the next.
// tests/_helpers/ may own env for a child process. An env object built for a spawn is a read, not a write.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const isProcessEnv = (e) => e.getText() === 'process.env';
const isEnvMember = (e) => (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && isProcessEnv(e.expression);

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => { visit(child, fn); });
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
    const assigns = ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && (isEnvMember(n.left) || isProcessEnv(n.left));
    const deletes = ts.isDeleteExpression(n) && isEnvMember(n.expression);
    const assignsInto = ts.isCallExpression(n) && n.expression.getText() === 'Object.assign' && n.arguments.length > 0 && isProcessEnv(n.arguments[0]);
    if (assigns || deletes || assignsInto) hits.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, write: n.getText().slice(0, 60) });
  });
  return hits;
}

function testFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '_helpers') testFiles(p, out); }
    else if (/\.(ts|mjs|cjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {{ file: string, line: number, write: string }[]}
 */
export function findEnvWrites(dir) {
  return testFiles(dir).flatMap((file) => envWrites(readFileSync(file, 'utf8')).map((hit) => ({ file: file.replace(/\\/g, '/'), ...hit })));
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? 'tests';
  const hits = findEnvWrites(dir);
  if (hits.length > 0) {
    console.error(`\nTests that write process.env by hand in ${dir}/:`);
    for (const h of hits) console.error(`  ${h.file}:${h.line} ${h.write}`);
    console.error('\nFix: vi.stubEnv(name, value) to set, vi.stubEnv(name, undefined) to unset, and vi.unstubAllEnvs() in afterEach.\n');
    process.exit(1);
  }
  console.log(`No test in ${dir}/ writes process.env by hand. OK.`);
}
