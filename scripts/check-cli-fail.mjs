#!/usr/bin/env node
// Fails when a CLI file prints an error and then throws CliExit(1) by hand. fail() in src/surface/cli/exit.ts does both,
// so the message and the exit code cannot drift apart. Zero allowed, no baseline.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { isTsSource, readFacts } from './lib/ts-facts.mjs';

const isCall = (stmt, name) =>
  ts.isExpressionStatement(stmt) &&
  ts.isCallExpression(stmt.expression) &&
  ts.isIdentifier(stmt.expression.expression) &&
  stmt.expression.expression.text === name;

/** `throw new CliExit(1)` as a statement. */
const isThrowExit1 = (stmt) => {
  const e = ts.isThrowStatement(stmt) ? stmt.expression : null;
  return (
    e !== null &&
    ts.isNewExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'CliExit' &&
    e.arguments?.length === 1 &&
    ts.isNumericLiteral(e.arguments[0]) &&
    e.arguments[0].text === '1'
  );
};

/**
 * Returns the 1-based line numbers of the printError calls that a hand-written throw follows.
 * A braceless `if (c) printError(x);` is no pair, since the throw after it is unconditional.
 * @param {string} text
 * @returns {number[]}
 */
export function failPairLines(text) {
  // A printError statement cannot exist without its text, so other files skip the parse.
  if (!text.includes('printError')) return [];
  const { sourceFile } = readFacts(text, 'file.ts', []);
  const lines = [];
  const visit = (n) => {
    const list =
      ts.isSourceFile(n) || ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseOrDefaultClause(n) ? n.statements : [];
    list.forEach((stmt, i) => {
      if (isCall(stmt, 'printError') && list[i + 1] && isThrowExit1(list[i + 1])) {
        lines.push(sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile)).line + 1);
      }
    });
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return lines.sort((a, b) => a - b);
}

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (isTsSource(name)) out.push(p);
  }
  return out;
}

/**
 * Finds every print-then-throw pair in src/cli.ts and src/surface/cli/ under srcDir.
 * @param {string} srcDir
 * @returns {{ file: string, line: number }[]}
 */
export function findFailPairs(srcDir) {
  const root = resolve(srcDir);
  return (
    listSourceFiles(root)
      .map((p) => [relative(root, p).replace(/\\/g, '/'), p])
      // exit.ts holds the one allowed pair: the body of fail().
      .filter(([file]) => (file === 'cli.ts' || file.startsWith('surface/cli/')) && file !== 'surface/cli/exit.ts')
      .flatMap(([file, p]) => failPairLines(readFileSync(p, 'utf8')).map((line) => ({ file, line })))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  );
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const hits = findFailPairs(srcDir);
  if (hits.length > 0) {
    console.error(`\n${hits.length} printError + throw new CliExit(1) pair(s) in the CLI under ${srcDir}/:`);
    for (const h of hits) console.error(`  ${srcDir}/${h.file}:${h.line}`);
    console.error('\nFix: call fail(...) from src/surface/cli/exit.ts, which prints the message and exits 1.\n');
    process.exit(1);
  }
  console.log('Every CLI error exit goes through fail(). OK.');
}
